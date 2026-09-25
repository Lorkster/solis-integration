import { localDate } from '../time.js';

/**
 * What really happened, per quarter-hour, next to what the day's first plan expected – for the
 * "plan vs actual" part of the battery plan widget.
 */
export interface ActualQuarter {
  t: string; // quarter start (ISO)
  soc: number; // battery level at the end of the quarter
  pvKw: number; // average solar power
  loadKw: number; // average house load
  price: number | null; // import price
  plannedSoc: number | null; // what the day's first plan expected at the end of the quarter
}

export interface ActualHistoryData {
  quarters: ActualQuarter[];
  dayPlan?: { date: string; soc: Record<string, number> }; // quarter start ms → planned SOC
}

const QUARTER_MS = 900_000;
const KEEP_MS = 30 * 3_600_000;

export class ActualHistory {
  private data: ActualHistoryData;
  private open: { q: number; pv: number; load: number; n: number; soc: number; price: number | null } | null = null;

  constructor(private readonly timeZone: string, data?: ActualHistoryData) {
    this.data = data ?? { quarters: [] };
  }

  /** Keeps the first plan made on each local day, as the reference for the rest of that day. */
  setDayPlan(now: Date, planned: Array<{ start: Date; socEndPct: number }>): void {
    const date = localDate(now, this.timeZone);
    if (this.data.dayPlan?.date === date) return;
    const soc: Record<string, number> = {};
    for (const p of planned) if (localDate(p.start, this.timeZone) === date) soc[p.start.getTime()] = Math.round(p.socEndPct * 10) / 10;
    this.data.dayPlan = { date, soc };
  }

  /** One live sample. A quarter is written when the first sample of the next one arrives. */
  add(time: Date, socPct: number, pvKw: number, loadKw: number, price: number | null): void {
    if (![socPct, pvKw, loadKw].every(Number.isFinite)) return;
    const q = Math.floor(time.getTime() / QUARTER_MS) * QUARTER_MS;
    if (this.open && this.open.q !== q) this.close();
    this.open ??= { q, pv: 0, load: 0, n: 0, soc: socPct, price };
    this.open.pv += pvKw;
    this.open.load += loadKw;
    this.open.n++;
    this.open.soc = socPct;
    if (price !== null) this.open.price = price;
  }

  private close(): void {
    const o = this.open;
    this.open = null;
    if (!o || o.n === 0) return;
    const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
    this.data.quarters = this.data.quarters.filter((x) => new Date(x.t).getTime() !== o.q);
    this.data.quarters.push({
      t: new Date(o.q).toISOString(),
      soc: round(o.soc, 1),
      pvKw: round(o.pv / o.n, 2),
      loadKw: round(o.load / o.n, 2),
      price: o.price === null ? null : round(o.price, 3),
      plannedSoc: this.data.dayPlan?.soc[o.q] ?? null,
    });
    const keepFrom = o.q - KEEP_MS;
    this.data.quarters = this.data.quarters.filter((x) => new Date(x.t).getTime() >= keepFrom);
  }

  /** Completed quarters from `from` on, oldest first. */
  since(from: Date): ActualQuarter[] {
    return this.data.quarters.filter((x) => new Date(x.t).getTime() >= from.getTime());
  }

  toJSON(): ActualHistoryData {
    return this.data;
  }
}
