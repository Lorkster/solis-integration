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

/** Combines irradiance forecasts for all arrays into a calibrated PV forecast per quarter hour. */
export class SolarForecaster {
  private modeled = new Map<number, number>(); // quarter start ms → uncalibrated kW

  constructor(
    private config: SolarForecastConfig,
    readonly calibration: SolarCalibration,
    private readonly provider: IrradianceProvider = new OpenMeteoProvider(),
  ) {}

  get kwpTotal(): number {
    return this.config.arrays.reduce((sum, a) => sum + a.kwp, 0);
  }

  /** Fetches irradiance (past `pastDays` days up to +2 days) and rebuilds the modeled series. */
  async refresh(pastDays = 1): Promise<void> {
    const modeled = new Map<number, number>();
    for (const array of this.config.arrays.filter((a) => a.kwp > 0)) {
      const series = await this.provider.get(this.config.latitude, this.config.longitude, array, pastDays);
      for (const irr of series) {
        const t = irr.start.getTime();
        modeled.set(t, (modeled.get(t) ?? 0) + modelPvKw(irr, array, this.config.performanceRatio));
      }
    }
    this.modeled = modeled;
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
