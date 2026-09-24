import { httpsRequest } from '../http.js';
import { localParts } from '../time.js';

/** One plane of panels. Azimuth: 0 = south, -90 = east, 90 = west (Open-Meteo convention). */
export interface SolarArray {
  kwp: number;
  tilt: number;
  azimuth: number;
}

export interface Irradiance {
  start: Date; // start of the 15-minute period
  gti: number; // W/m² on the panel plane
  tempC: number;
}

export interface IrradianceProvider {
  get(lat: number, lon: number, array: SolarArray, pastDays: number): Promise<Irradiance[]>;
}

/** Open-Meteo 15-minute forecast (free, no key). Includes past days for calibration. */
export class OpenMeteoProvider implements IrradianceProvider {
  private readonly cache = new Map<string, { at: number; data: Irradiance[] }>();

  async get(lat: number, lon: number, array: SolarArray, pastDays: number): Promise<Irradiance[]> {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)},${array.tilt},${array.azimuth},${pastDays}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 3_600_000) return cached.data;

    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${lat}&longitude=${lon}&tilt=${array.tilt}&azimuth=${array.azimuth}`
      + '&minutely_15=global_tilted_irradiance,temperature_2m'
      + `&forecast_days=3&past_days=${pastDays}&timezone=UTC`;
    const response = await httpsRequest(url, { timeoutMs: 20_000 });
    if (response.status !== 200) throw new Error(`Open-Meteo HTTP ${response.status}`);
    const json = JSON.parse(response.body) as {
      minutely_15: { time: string[]; global_tilted_irradiance: (number | null)[]; temperature_2m: (number | null)[] };
    };
    const m = json.minutely_15;
    const data = m.time.map((t, i) => ({
      start: new Date(`${t}Z`),
      gti: m.global_tilted_irradiance[i] ?? 0,
      tempC: m.temperature_2m[i] ?? 10,
    }));
    this.cache.set(key, { at: Date.now(), data });
    return data;
  }
}

const TEMP_COEFFICIENT = -0.004; // per °C, crystalline silicon

/**
 * True when solar output looks throttled by the inverter rather than limited by the sun: nothing is
 * exported and the battery is not charging, yet solar covers the whole house load. Such samples say
 * nothing about what the panels could produce and must not be used for calibration.
 */
export function looksCurtailed(pvKw: number, loadKw: number, gridKw: number, batteryKw: number): boolean {
  const exportKw = Math.max(0, -gridKw);
  return pvKw > 0.5 && exportKw < 0.5 && batteryKw < 0.2 && pvKw >= loadKw - 0.2;
}

/** Physical estimate of AC output (kW) for one array, before calibration. */
export function modelPvKw(irr: Irradiance, array: SolarArray, performanceRatio: number): number {
  if (irr.gti <= 0) return 0;
  const cellTemp = irr.tempC + irr.gti / 800 * 20; // NOCT-style approximation
  const tempFactor = 1 + TEMP_COEFFICIENT * (cellTemp - 25);
  return Math.max(0, irr.gti / 1000 * array.kwp * performanceRatio * tempFactor);
}

export interface CalibrationData {
  version: 2;
  actual: number[]; // decayed sum of measured kW per local hour of day
  modeled: number[]; // decayed sum of modeled kW per local hour of day
  count: number[];
}

/**
 * Learns how the real installation deviates from the physical model, per hour of day
 * (orientation errors, shading from trees or buildings, soiling). Uses exponentially decayed
 * sums of measured and modeled power, so a factor is a ratio of energies - robust against the
 * noisy per-quarter ratios on cloudy days - and recent weeks weigh most.
 */
export class SolarCalibration {
  private data: CalibrationData;

  constructor(private readonly timeZone: string, data?: CalibrationData, private readonly decay = 0.98) {
    this.data = data?.version === 2 ? data : {
      version: 2,
      actual: new Array(24).fill(0),
      modeled: new Array(24).fill(0),
      count: new Array(24).fill(0),
    };
  }

  /** Adds one quarter-hour comparison. Ignores low light where the model is least reliable. */
  add(time: Date, modeledKw: number, actualKw: number, kwpTotal: number): void {
    if (modeledKw < 0.1 * kwpTotal || !Number.isFinite(actualKw) || actualKw < 0) return;
    const hour = localParts(time, this.timeZone).hour;
    this.data.actual[hour] = this.data.actual[hour] * this.decay + actualKw;
    this.data.modeled[hour] = this.data.modeled[hour] * this.decay + modeledKw;
    this.data.count[hour] = Math.min(this.data.count[hour] + 1, 10_000);
  }

  factorAt(time: Date): number {
    const hour = localParts(time, this.timeZone).hour;
    if (this.data.count[hour] < 8) return 1;
    return Math.min(1.5, Math.max(0.1, this.data.actual[hour] / this.data.modeled[hour]));
  }

  get observations(): number {
    return this.data.count.reduce((a, b) => a + b, 0);
  }

  toJSON(): CalibrationData {
    return this.data;
  }
}

export interface SolarForecastConfig {
  latitude: number;
  longitude: number;
  arrays: SolarArray[];
  performanceRatio: number;
  maxAcKw: number; // inverter limit
}

export type SolarSource = 'open_meteo' | 'forecast_solar' | 'solcast';

/** Uncalibrated expected PV power per quarter-hour, from any forecast service. */
export interface PvPowerProvider {
  /** True when the service also returns past days, so history can calibrate the forecast at once. */
  readonly hasHistory: boolean;
  /** kW per quarter-hour start (ms) for all arrays combined, from `pastDays` ago up to ~2 days ahead. */
  getPower(config: SolarForecastConfig, pastDays: number): Promise<Map<number, number>>;
}

const QUARTER_MS = 900_000;
const quarterOf = (ms: number) => Math.floor(ms / QUARTER_MS) * QUARTER_MS;

/** Irradiance on each array's plane through the physical PV model (Open-Meteo by default). */
export class IrradiancePowerProvider implements PvPowerProvider {
  readonly hasHistory = true;

  constructor(private readonly irradiance: IrradianceProvider = new OpenMeteoProvider()) {}

  async getPower(config: SolarForecastConfig, pastDays: number): Promise<Map<number, number>> {
    const power = new Map<number, number>();
    for (const array of config.arrays.filter((a) => a.kwp > 0)) {
      for (const irr of await this.irradiance.get(config.latitude, config.longitude, array, pastDays)) {
        const t = irr.start.getTime();
        power.set(t, (power.get(t) ?? 0) + modelPvKw(irr, array, config.performanceRatio));
      }
    }
    return power;
  }
}

/**
 * Turns power readings at points in time (W) into quarter-hour averages (kW), by linear
 * interpolation at the middle of each quarter. Outside the points the power is zero.
 */
export function pointsToQuarters(points: Array<[number, number]>): Map<number, number> {
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const out = new Map<number, number>();
  if (sorted.length < 2) return out;
  let i = 0;
  for (let q = quarterOf(sorted[0][0]); q < sorted[sorted.length - 1][0]; q += QUARTER_MS) {
    const mid = q + QUARTER_MS / 2;
    while (i < sorted.length - 2 && sorted[i + 1][0] <= mid) i++;
    const [t0, w0] = sorted[i];
    const [t1, w1] = sorted[i + 1];
    const w = mid <= t0 || mid >= t1 ? 0 : w0 + (w1 - w0) * (mid - t0) / (t1 - t0);
    out.set(q, Math.max(0, w) / 1000);
  }
  return out;
}

/**
 * Forecast.Solar (free, no account; an API key unlocks the paid plans). Hourly production
 * estimates per array for today and tomorrow. The free plan allows 12 requests an hour, so results
 * are kept for an hour.
 */
export class ForecastSolarProvider implements PvPowerProvider {
  readonly hasHistory = false;
  private readonly cache = new Map<string, { at: number; points: Array<[number, number]> }>();

  constructor(private readonly apiKey = '') {}

  async getPower(config: SolarForecastConfig): Promise<Map<number, number>> {
    const power = new Map<number, number>();
    for (const array of config.arrays.filter((a) => a.kwp > 0)) {
      for (const [t, kw] of pointsToQuarters(await this.points(config, array))) power.set(t, (power.get(t) ?? 0) + kw);
    }
    return power;
  }

  private async points(config: SolarForecastConfig, array: SolarArray): Promise<Array<[number, number]>> {
    const key = this.apiKey ? `${encodeURIComponent(this.apiKey)}/` : '';
    const url = `https://api.forecast.solar/${key}estimate/watts/${config.latitude.toFixed(4)}/${config.longitude.toFixed(4)}`
      + `/${array.tilt}/${array.azimuth}/${array.kwp}?time=utc`;
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.at < 3_600_000) return cached.points;
    const response = await httpsRequest(url, { timeoutMs: 20_000, headers: { Accept: 'application/json' } });
    if (response.status === 429 && cached) return cached.points; // rate limited: keep the last forecast
    if (response.status !== 200) throw new Error(`Forecast.Solar HTTP ${response.status}`);
    const result = (JSON.parse(response.body) as { result: Record<string, number> }).result;
    const points = Object.entries(result).map(([time, watts]): [number, number] => [new Date(time).getTime(), watts]);
    this.cache.set(url, { at: Date.now(), points });
    return points;
  }
}

/**
 * Solcast rooftop sites (free hobbyist account: up to two sites, 10 requests a day). The site's
 * size and orientation are set up at Solcast, so the arrays here only give the total kWp. Requests
 * are spread over the day to stay inside the limit.
 */
export class SolcastProvider implements PvPowerProvider {
  readonly hasHistory = false;
  private readonly cache = new Map<string, { at: number; power: Map<number, number> }>();

  constructor(private readonly apiKey: string, private readonly siteIds: string[], private readonly dailyLimit = 10) {
    if (!apiKey || siteIds.length === 0) throw new Error('Solcast needs an API key and at least one site ID');
  }

  /** Minimum time between requests per site, keeping one request a day spare. */
  get minIntervalMs(): number {
    const perSite = Math.max(1, Math.floor((this.dailyLimit - 1) / this.siteIds.length));
    return 86_400_000 / perSite;
  }

  async getPower(): Promise<Map<number, number>> {
    const power = new Map<number, number>();
    for (const site of this.siteIds) {
      for (const [t, kw] of await this.site(site)) power.set(t, (power.get(t) ?? 0) + kw);
    }
    return power;
  }

  private async site(id: string): Promise<Map<number, number>> {
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < this.minIntervalMs) return cached.power;
    const url = `https://api.solcast.com.au/rooftop_sites/${encodeURIComponent(id)}/forecasts?format=json&hours=48`;
    const response = await httpsRequest(url, { timeoutMs: 20_000, headers: { Authorization: `Bearer ${this.apiKey}` } });
    if (response.status === 429 && cached) return cached.power;
    if (response.status !== 200) throw new Error(`Solcast HTTP ${response.status}`);
    const power = parseSolcast(JSON.parse(response.body));
    this.cache.set(id, { at: Date.now(), power });
    return power;
  }
}

/** Solcast periods (pv_estimate in kW, averaged over the period ending at period_end) → quarters. */
export function parseSolcast(json: unknown): Map<number, number> {
  const out = new Map<number, number>();
  const forecasts = (json as { forecasts?: Array<{ pv_estimate: number; period_end: string; period?: string }> }).forecasts ?? [];
  for (const f of forecasts) {
    const minutes = Number(/PT(\d+)M/.exec(f.period ?? '')?.[1] ?? 30);
    const end = new Date(f.period_end).getTime();
    for (let t = quarterOf(end - minutes * 60_000); t < end; t += QUARTER_MS) out.set(t, Math.max(0, f.pv_estimate));
  }
  return out;
}

export function createPvPowerProvider(source: SolarSource, apiKey: string, solcastSites: string): PvPowerProvider {
  if (source === 'forecast_solar') return new ForecastSolarProvider(apiKey);
  if (source === 'solcast') {
    return new SolcastProvider(apiKey, solcastSites.split(/[\s,;]+/).map((id) => id.trim()).filter(Boolean));
  }
  return new IrradiancePowerProvider();
}

/** Combines the forecast service's power estimate with the learned calibration, per quarter hour. */
export class SolarForecaster {
  private modeled = new Map<number, number>(); // quarter start ms → uncalibrated kW

  constructor(
    private config: SolarForecastConfig,
    readonly calibration: SolarCalibration,
    readonly provider: PvPowerProvider = new IrradiancePowerProvider(),
  ) {}

  get kwpTotal(): number {
    return this.config.arrays.reduce((sum, a) => sum + a.kwp, 0);
  }

  /**
   * Fetches the forecast (past `pastDays` days, if the service has them, up to +2 days). Values for
   * times the service no longer returns are kept for three days, so completed quarters can still be
   * compared with what was measured.
   */
  async refresh(pastDays = 1): Promise<void> {
    const fresh = await this.provider.getPower(this.config, pastDays);
    const keepFrom = Date.now() - 3 * 86_400_000;
    for (const [t, kw] of this.modeled) if (t >= keepFrom && !fresh.has(t)) fresh.set(t, kw);
    this.modeled = fresh;
  }

  /** Uncalibrated modeled kW for the quarter containing `time`, or null if unknown. */
  modeledAt(time: Date): number | null {
    return this.modeled.get(Math.floor(time.getTime() / 900_000) * 900_000) ?? null;
  }

  /** Calibrated expected PV power (kW) for the quarter containing `time`. */
  forecastAt(time: Date): number | null {
    const modeled = this.modeledAt(time);
    if (modeled === null) return null;
    return Math.min(this.config.maxAcKw, modeled * this.calibration.factorAt(time));
  }

  /** Feeds an observed quarter-hour average PV power into the calibration. */
  learn(time: Date, actualKw: number): void {
    const modeled = this.modeledAt(time);
    if (modeled !== null) this.calibration.add(time, modeled, actualKw, this.kwpTotal);
  }
}
