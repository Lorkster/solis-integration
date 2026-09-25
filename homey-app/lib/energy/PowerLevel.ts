import { httpsRequest } from '../http.js';

/**
 * "Is extra power cheap, normal or expensive right now?" – for flows that shift flexible loads
 * such as a heat pump's target temperature. The cost compared is the cost of one more kWh now
 * (see extraPowerCost): solar that would be exported, the battery's energy, or the import price.
 */
export type PowerLevel = 'cheap' | 'normal' | 'expensive';

export interface PowerLevelConfig {
  mode: 'auto' | 'manual';
  /** auto: cheap = the cheapest share of the next 24 hours' import prices, expensive = the priciest share. */
  sharePct: number;
  /** manual limits, per kWh */
  cheapBelow: number;
  expensiveAbove: number;
}

export interface LevelLimits {
  cheapBelow: number;
  expensiveAbove: number;
}

/** Below this spread (relative to the median) no price is really cheap or expensive. */
const MIN_RELATIVE_SPREAD = 0.05;

/** Limits from the import prices of the next 24 hours (auto) or as set (manual); null without prices. */
export function levelLimits(prices: number[], config: PowerLevelConfig): LevelLimits | null {
  if (config.mode === 'manual') {
    return { cheapBelow: config.cheapBelow, expensiveAbove: Math.max(config.expensiveAbove, config.cheapBelow) };
  }
  const sorted = prices.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < 8) return null;
  const share = Math.min(50, Math.max(5, config.sharePct)) / 100;
  const count = Math.max(1, Math.ceil(share * sorted.length));
  const limits = { cheapBelow: sorted[count - 1], expensiveAbove: sorted[sorted.length - count] };
  const median = sorted[Math.floor(sorted.length / 2)];
  if (limits.expensiveAbove - limits.cheapBelow < MIN_RELATIVE_SPREAD * Math.abs(median)) {
    // A flat day: everything is normal.
    return { cheapBelow: -Infinity, expensiveAbove: Infinity };
  }
  return limits;
}

/**
 * The level of `cost`. A level is only left when the cost moves past its limit by a margin (5 % of
 * the gap between the limits), so a cost wobbling around a limit does not flip the level back and forth.
 */
export function powerLevel(cost: number, limits: LevelLimits, previous: PowerLevel | null = null): PowerLevel {
  const gap = limits.expensiveAbove - limits.cheapBelow;
  const margin = Number.isFinite(gap) ? Math.max(0.01, 0.05 * gap) : 0;
  if (previous === 'cheap' && cost <= limits.cheapBelow + margin) return 'cheap';
  if (previous === 'expensive' && cost >= limits.expensiveAbove - margin) return 'expensive';
  if (cost <= limits.cheapBelow) return 'cheap';
  if (cost >= limits.expensiveAbove) return 'expensive';
  return 'normal';
}

/** Another way to heat, such as a wood stove, compared with an air-source heat pump. */
export interface AlternativeHeat {
  /** What one kWh of heat from the alternative costs (0 = no alternative). */
  costPerKwh: number;
  /** The heat pump's COP (heat out per electricity in) at +7 °C and −7 °C outdoors, from its data sheet. */
  copAt7: number;
  copAtMinus7: number;
}

/** The heat pump's COP at an outdoor temperature: a straight line through the two data-sheet points. */
export function heatPumpCop(outdoorC: number | null, heat: AlternativeHeat): number {
  const t = outdoorC !== null && Number.isFinite(outdoorC) ? outdoorC : 0; // unknown: assume 0 °C
  const cop = heat.copAtMinus7 + ((t + 7) / 14) * (heat.copAt7 - heat.copAtMinus7);
  return Math.min(Math.max(cop, 1), heat.copAt7 * 1.3);
}

/** The electricity cost per kWh above which the alternative gives cheaper heat; null without an alternative. */
export function breakEvenCost(outdoorC: number | null, heat: AlternativeHeat): number | null {
  if (!(heat.costPerKwh > 0)) return null;
  return heat.costPerKwh * heatPumpCop(outdoorC, heat);
}

/** True when heat from the alternative is cheaper than from the heat pump now (3 % margin to switch back). */
export function alternativeCheaper(cost: number, breakEven: number | null, previous: boolean | null = null): boolean {
  if (breakEven === null) return false;
  const margin = 0.03 * breakEven;
  return previous ? cost > breakEven - margin : cost > breakEven;
}

/** The current outdoor temperature from Open-Meteo (no key needed). */
export async function fetchOutdoorTemperature(lat: number, lon: number): Promise<number> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m`;
  const response = await httpsRequest(url, { timeoutMs: 20_000 });
  if (response.status !== 200) throw new Error(`Open-Meteo HTTP ${response.status}`);
  const t = (JSON.parse(response.body) as { current?: { temperature_2m?: unknown } }).current?.temperature_2m;
  if (typeof t !== 'number') throw new Error('Open-Meteo: no current temperature');
  return t;
}
