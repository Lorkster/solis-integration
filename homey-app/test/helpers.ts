import type { PlanInterval } from '../lib/planner/planner.js';

export const TZ = 'Europe/Stockholm';

/** Quarter-hour intervals starting at `start`, one per price. */
export function intervals(start: string, buyPrices: number[], loadKw = 2): PlanInterval[] {
  const t0 = new Date(start).getTime();
  return buyPrices.map((buy, i) => ({
    start: new Date(t0 + i * 900_000),
    end: new Date(t0 + (i + 1) * 900_000),
    buy,
    sell: 0.5,
    loadKw,
    pvKw: 0,
  }));
}

/** Repeat each hourly price four times (hourly → 15-minute). */
export function quarters(hourly: number[]): number[] {
  return hourly.flatMap((p) => [p, p, p, p]);
}
