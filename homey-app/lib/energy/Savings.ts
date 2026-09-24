import { localDate } from '../time.js';

/**
 * Measured savings: what electricity actually cost, compared with what it would have cost with the
 * same consumption and solar production but no battery (import = load − solar when positive,
 * export = the rest). Charging losses and wear are part of the actual cost; solar that was curtailed
 * is not counted in either.
 */
export interface SavingsSample {
  time: Date;
  hours: number; // length of time the sample stands for
  gridW: number; // positive = import
  loadW: number;
  pvW: number;
  buy: number; // price per kWh bought
  sell: number; // price per kWh sold
}

export interface CostTotals {
  actual: number;
  withoutBattery: number;
}

export interface SavingsData {
  days: Record<string, CostTotals>; // local date → energy costs
  months: Record<string, CostTotals & { powerFee?: number }>; // "YYYY-MM" → energy costs (+ fee difference)
}

const KEEP_DAYS = 62;
const KEEP_MONTHS = 25;

export class SavingsTracker {
  private data: SavingsData;

  constructor(private readonly timeZone: string, data?: SavingsData) {
    this.data = data ?? { days: {}, months: {} };
  }

  add(s: SavingsSample): void {
    if (![s.gridW, s.loadW, s.pvW, s.buy, s.sell, s.hours].every(Number.isFinite) || s.hours <= 0) return;
    const cost = (gridKw: number) => (gridKw >= 0 ? gridKw * s.buy : gridKw * s.sell) * s.hours;
    const actual = cost(s.gridW / 1000);
    const withoutBattery = cost((s.loadW - s.pvW) / 1000);
    const day = localDate(s.time, this.timeZone);
    const month = day.slice(0, 7);
    const d = (this.data.days[day] ??= { actual: 0, withoutBattery: 0 });
    d.actual += actual;
    d.withoutBattery += withoutBattery;
    const m = (this.data.months[month] ??= { actual: 0, withoutBattery: 0 });
    m.actual += actual;
    m.withoutBattery += withoutBattery;
    this.prune();
  }

  /** Difference in this month's power fee with and without the battery (kept from peak tracking). */
  setPowerFeeSaving(month: string, amount: number): void {
    const m = (this.data.months[month] ??= { actual: 0, withoutBattery: 0 });
    m.powerFee = amount;
  }

  /** Saved on a local day (energy only). */
  savedOn(date: string): number {
    const d = this.data.days[date];
    return d ? d.withoutBattery - d.actual : 0;
  }

  /** Saved in a month ("YYYY-MM"), including the lower power fee. */
  savedInMonth(month: string): number {
    const m = this.data.months[month];
    return m ? m.withoutBattery - m.actual + (m.powerFee ?? 0) : 0;
  }

  private prune(): void {
    const days = Object.keys(this.data.days).sort();
    for (const d of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) delete this.data.days[d];
    const months = Object.keys(this.data.months).sort();
    for (const m of months.slice(0, Math.max(0, months.length - KEEP_MONTHS))) delete this.data.months[m];
  }

  toJSON(): SavingsData {
    return this.data;
  }
}
