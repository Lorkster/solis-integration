import { localParts } from '../time.js';
import type { PlannedInterval } from './planner.js';

/**
 * "When is the best time to run the dishwasher?" The cost of running an appliance in a
 * quarter-hour depends on what the plan expects there: solar that would otherwise be sold costs
 * only the export price, power bought from the grid costs the import price, and power the battery
 * gives costs what that energy is worth later. So a sunny noon can beat a cheap night.
 */

const QUARTER_MS = 900_000;
/** Planned grid flow below this counts as balanced (the battery takes the difference). */
const BALANCED_KW = 0.15;

/** Cost per kWh of running an appliance of `powerKw` during one planned quarter-hour. */
export function applianceCost(iv: PlannedInterval, powerKw: number): number {
  const hours = (iv.end.getTime() - iv.start.getTime()) / 3_600_000;
  const gridKw = iv.gridKwh / hours; // planned, positive = import
  const fromSurplus = Math.min(powerKw, Math.max(0, -gridKw));
  const rest = powerKw - fromSurplus;
  const restCost = gridKw > BALANCED_KW || iv.storedEnergyValue <= 0 ? iv.buy : Math.min(iv.buy, iv.storedEnergyValue);
  return (fromSurplus * iv.sell + rest * restCost) / Math.max(powerKw, 1e-9);
}

/** Next local occurrence of "HH:MM" after `after`. */
export function nextTime(hhmm: string, after: Date, timeZone: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  // Walk forward minute by minute (handles DST) until the wall clock matches.
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (let i = 0; i < 2 * 24 * 60 + 120; i++, t += 60_000) {
    const q = localParts(new Date(t), timeZone);
    if (q.hour === h && q.minute === m) return new Date(t);
  }
  throw new Error(`Invalid time ${hhmm}`);
}

export interface BestWindow {
  start: Date;
  end: Date;
  costPerKwh: number; // average over the run
}

/**
 * The cheapest start (on a quarter-hour, from the current quarter) for a run of `minutes` that
 * ends by `deadline`, using the planned quarter-hours. When the deadline is too close for the run,
 * the same time the next day is used. Null when the prices do not reach far enough.
 */
export function bestWindow(
  intervals: PlannedInterval[],
  now: Date,
  minutes: number,
  powerKw: number,
  deadlineHHMM: string,
  timeZone: string,
): BestWindow | null {
  const quarters = Math.max(1, Math.ceil(minutes / 15));
  let deadline = nextTime(deadlineHHMM, now, timeZone);
  if (deadline.getTime() - now.getTime() < minutes * 60_000) deadline = nextTime(deadlineHHMM, new Date(deadline.getTime() + 60_000), timeZone);
  const first = Math.floor(now.getTime() / QUARTER_MS) * QUARTER_MS;
  const usable = intervals.filter((iv) => iv.start.getTime() >= first && iv.end <= deadline);
  let best: BestWindow | null = null;
  for (let i = 0; i + quarters <= usable.length; i++) {
    const run = usable.slice(i, i + quarters);
    // Only continuous runs of quarter-hours.
    if (run[run.length - 1].end.getTime() - run[0].start.getTime() !== quarters * QUARTER_MS) continue;
    const cost = run.reduce((sum, iv) => sum + applianceCost(iv, powerKw), 0) / quarters;
    if (!best || cost < best.costPerKwh - 1e-9) best = { start: run[0].start, end: run[run.length - 1].end, costPerKwh: cost };
  }
  return best;
}

/** True when the best window starts in the current quarter-hour. */
export function isBestTimeNow(best: BestWindow | null, now: Date): boolean {
  return best !== null && best.start.getTime() <= now.getTime() && now.getTime() < best.start.getTime() + QUARTER_MS;
}
