import { localDate, localParts } from '../time.js';

/**
 * Power-based grid fee ("effektavgift"): each month the grid company charges per kW of the average
 * of the N highest import peaks. A peak is the average import over one hour (or quarter-hour),
 * often only counted on some hours or months, and sometimes only one per day. Some companies count
 * night hours at a fraction (Ellevio: 22–06 at half).
 */
export interface PowerTariffConfig {
  enabled: boolean;
  pricePerKwMonth: number;
  peaks: number; // number of highest peaks averaged
  distinctDays: boolean; // at most one peak per day
  periodMinutes: 60 | 15;
  winterOnly: boolean; // counted November–March only
  weekdaysOnly: boolean; // counted Monday–Friday only
  fromHour: number; // counted window, local time
  toHour: number; // exclusive; 24 = midnight
  outsideWeight: number; // how hours outside the window count: 0 = not at all, 0.5 = half
}

export const NO_POWER_TARIFF: PowerTariffConfig = {
  enabled: false,
  pricePerKwMonth: 0,
  peaks: 3,
  distinctDays: true,
  periodMinutes: 60,
  winterOnly: false,
  weekdaysOnly: false,
  fromHour: 0,
  toHour: 24,
  outsideWeight: 0,
};

/** How much import at this time counts towards the fee (0 = not counted, 1 = fully). */
export function peakWeight(time: Date, timeZone: string, cfg: PowerTariffConfig): number {
  if (!cfg.enabled || cfg.pricePerKwMonth <= 0) return 0;
  const { month, weekday, hour } = localParts(time, timeZone);
  if (cfg.winterOnly && !(month >= 11 || month <= 3)) return 0;
  if (cfg.weekdaysOnly && (weekday === 0 || weekday === 6)) return 0;
  const inside = cfg.fromHour <= cfg.toHour
    ? hour >= cfg.fromHour && hour < cfg.toHour
    : hour >= cfg.fromHour || hour < cfg.toHour;
  return inside ? 1 : Math.max(0, Math.min(1, cfg.outsideWeight));
}

export interface PeakData {
  month: string; // "YYYY-MM"
  dayMax: Record<string, number>; // local date → highest weighted peak (kW) that day
  top: number[]; // highest weighted peaks this month regardless of day (kW), descending
  previousMonthLevel: number | null; // fee-setting level of the previous month (kW)
  period?: { start: number; sumW: number; n: number }; // period being measured
}

/**
 * Measures import peaks as the grid company does, from live samples, and keeps the month's
 * highest ones. Used both for the actual import and for "what the import would have been without
 * the battery" (the savings baseline).
 */
export class PeakTracker {
  private data: PeakData;

  constructor(private readonly timeZone: string, private cfg: PowerTariffConfig, data?: PeakData) {
    this.data = data ?? { month: '', dayMax: {}, top: [], previousMonthLevel: null };
  }

  set config(cfg: PowerTariffConfig) {
    this.cfg = cfg;
  }

  /** Adds a sample of grid import (W, negative = export counts as zero). */
  addSample(time: Date, importW: number): void {
    if (!Number.isFinite(importW)) return;
    const periodMs = this.cfg.periodMinutes * 60_000;
    const start = Math.floor(time.getTime() / periodMs) * periodMs;
    const p = this.data.period;
    if (p && p.start !== start) this.close();
    if (!this.data.period || this.data.period.start !== start) this.data.period = { start, sumW: 0, n: 0 };
    this.data.period.sumW += Math.max(0, importW);
    this.data.period.n++;
  }

  /** Records the period being measured (called when the next one starts). */
  private close(): void {
    const p = this.data.period;
    this.data.period = undefined;
    if (!p || p.n === 0) return;
    const start = new Date(p.start);
    this.record(start, p.sumW / p.n / 1000 * peakWeight(start, this.timeZone, this.cfg));
  }

  record(start: Date, weightedKw: number): void {
    const month = localDate(start, this.timeZone).slice(0, 7);
    if (month !== this.data.month) {
      if (this.data.month) this.data.previousMonthLevel = this.feeLevelKw();
      this.data = { ...this.data, month, dayMax: {}, top: [] };
    }
    if (weightedKw <= 0) return;
    const day = localDate(start, this.timeZone);
    this.data.dayMax[day] = Math.max(this.data.dayMax[day] ?? 0, weightedKw);
    this.data.top = [...this.data.top, weightedKw].sort((a, b) => b - a).slice(0, Math.max(1, this.cfg.peaks));
  }

  /** The month's highest counted peaks, descending (at most N). */
  topPeaks(): number[] {
    const values = this.cfg.distinctDays ? Object.values(this.data.dayMax).sort((a, b) => b - a) : this.data.top;
    return values.slice(0, Math.max(1, this.cfg.peaks));
  }

  /** Average of the N highest peaks so far: what this month's fee is based on (kW). */
  feeLevelKw(): number {
    const top = this.topPeaks();
    return top.length === 0 ? 0 : top.reduce((a, b) => a + b, 0) / top.length;
  }

  /** The month's fee so far, in the price's currency. */
  feeSoFar(): number {
    return this.feeLevelKw() * this.cfg.pricePerKwMonth;
  }

  /**
   * Import level (weighted kW) above which a period raises this month's fee: the N-th highest peak
   * once there are N, otherwise the lowest recorded one (a new day early in the month will be among
   * the top N, but should not be much higher than the days before), or last month's level.
   */
  thresholdKw(): number {
    const top = this.topPeaks();
    return top.length > 0 ? top[top.length - 1] : this.data.previousMonthLevel ?? 0;
  }

  /**
   * The weighted average the current period is heading for, if the import stays at `nowW` until it
   * ends; null outside counted hours.
   */
  projectedKw(now: Date, nowW: number): number | null {
    const weight = peakWeight(now, this.timeZone, this.cfg);
    if (weight === 0) return null;
    const periodMs = this.cfg.periodMinutes * 60_000;
    const start = Math.floor(now.getTime() / periodMs) * periodMs;
    const p = this.data.period?.start === start ? this.data.period : null;
    const elapsed = (now.getTime() - start) / periodMs;
    const soFarKw = p && p.n > 0 ? p.sumW / p.n / 1000 : Math.max(0, nowW) / 1000;
    return (soFarKw * elapsed + Math.max(0, nowW) / 1000 * (1 - elapsed)) * weight;
  }

  toJSON(): PeakData {
    return this.data;
  }
}
