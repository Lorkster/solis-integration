import { localHHMM } from '../time.js';
import type { BatteryAction, PlannedInterval } from './planner.js';

export type Language = 'en' | 'sv';

/**
 * What the battery and house are doing in a period, named by what powers what. Every quarter-hour
 * gets exactly one state, so nothing in the plan is left unexplained.
 */
export type PeriodState = 'grid_charge' | 'save' | 'battery' | 'solar_charge' | 'at_reserve' | 'full';

export const PERIOD_STATES: readonly PeriodState[] = ['grid_charge', 'save', 'battery', 'solar_charge', 'at_reserve', 'full'];

/** Names used in lists, legends and on the device tile. */
export const PERIOD_NAMES: Record<Language, Record<PeriodState, string>> = {
  en: {
    grid_charge: 'Grid charging',
    save: 'Saving for later',
    battery: 'Battery powers house',
    solar_charge: 'Solar charging',
    at_reserve: 'At reserve · grid powers house',
    full: 'Full · solar powers house',
  },
  sv: {
    grid_charge: 'Nätladdning',
    save: 'Sparar till senare',
    battery: 'Batteriet driver huset',
    solar_charge: 'Solladdning',
    at_reserve: 'Vid reserv · nätet driver huset',
    full: 'Fullt · solen driver huset',
  },
};

const UNTIL: Record<Language, string> = { en: 'until', sv: 'till' };

/**
 * A "save" only makes sense with a meaningful amount of energy above the reserve (5 percentage
 * points, about 1 kWh on a 21.7 kWh battery). Smaller saves are not sent to the inverter.
 */
export const MIN_SAVE_ABOVE_RESERVE_PCT = 5;
/** Periods shorter than this (other than planned charging and saving) merge into their neighbour. */
export const MIN_PERIOD_MINUTES = 30;
/** Battery flow per quarter-hour (kWh) below which the battery counts as not moving. */
const MOVING_KWH_PER_QUARTER = 0.05;

export function isPointlessSave(action: BatteryAction, socStartPct: number, reserveSoc: number): boolean {
  return action === 'hold' && socStartPct < reserveSoc + MIN_SAVE_ABOVE_RESERVE_PCT;
}

/** Plan action with pointless saves treated as self-use (they are not sent to the inverter). */
export function displayAction(iv: PlannedInterval, reserveSoc: number): BatteryAction {
  return isPointlessSave(iv.action, iv.socStartPct, reserveSoc) ? 'self_use' : iv.action;
}

/** State of a single quarter-hour. */
export function intervalState(iv: PlannedInterval, reserveSoc: number, maxSoc: number): PeriodState {
  const action = displayAction(iv, reserveSoc);
  if (action === 'charge') return 'grid_charge';
  if (action === 'hold') return 'save';
  if (iv.batteryKwh <= -MOVING_KWH_PER_QUARTER) return 'battery';
  if (iv.batteryKwh >= MOVING_KWH_PER_QUARTER) return 'solar_charge';
  return iv.socStartPct >= maxSoc - 2 ? 'full' : 'at_reserve';
}

export interface Period {
  state: PeriodState;
  start: Date;
  end: Date;
  socStartPct: number;
  socEndPct: number;
}

const PLANNED: ReadonlySet<PeriodState> = new Set(['grid_charge', 'save']);

/**
 * Groups the plan into named periods. Short periods that are just the battery following the house
 * (a brief dip or a moment of solar surplus) merge into the period before them, so the list shows
 * what matters. Planned charging and saving are never merged away: they are what the inverter does.
 */
export function planPeriods(intervals: PlannedInterval[], reserveSoc: number, maxSoc: number): Period[] {
  const raw: Period[] = [];
  for (const iv of intervals) {
    const state = intervalState(iv, reserveSoc, maxSoc);
    const last = raw[raw.length - 1];
    if (last && last.state === state && last.end.getTime() === iv.start.getTime()) {
      last.end = iv.end;
      last.socEndPct = iv.socEndPct;
    } else {
      raw.push({ state, start: iv.start, end: iv.end, socStartPct: iv.socStartPct, socEndPct: iv.socEndPct });
    }
  }

  const minutes = (p: Period) => (p.end.getTime() - p.start.getTime()) / 60_000;
  const out: Period[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const last = out[out.length - 1];
    if (!PLANNED.has(p.state) && minutes(p) < MIN_PERIOD_MINUTES) {
      if (last && !PLANNED.has(last.state)) {
        last.end = p.end;
        last.socEndPct = p.socEndPct;
        continue;
      }
      const next = raw[i + 1];
      if (next && !PLANNED.has(next.state)) {
        next.start = p.start;
        next.socStartPct = p.socStartPct;
        continue;
      }
    }
    if (last && last.state === p.state) {
      last.end = p.end;
      last.socEndPct = p.socEndPct;
    } else {
      out.push({ ...p });
    }
  }
  return out;
}

/**
 * One short line for the device tile: what happens now and the next planned actions (grid charging
 * and saving), e.g. "Battery powers house until 21:00 · Grid charging 13:45–15:30". The widget's list
 * shows every period.
 */
export function planSummary(
  intervals: PlannedInterval[],
  now: Date,
  reserveSoc: number,
  maxSoc: number,
  timeZone: string,
  language: Language = 'en',
): string {
  const names = PERIOD_NAMES[language];
  const upcoming = intervals.filter((iv) => iv.end > now && iv.start < new Date(now.getTime() + 86_400_000));
  if (upcoming.length === 0) return '';
  const [current, ...rest] = planPeriods(upcoming, reserveSoc, maxSoc);
  const head = `${names[current.state]} ${UNTIL[language]} ${localHHMM(current.end, timeZone)}`;
  const next = rest
    .filter((p) => PLANNED.has(p.state))
    .slice(0, 2)
    .map((p) => `${names[p.state]} ${localHHMM(p.start, timeZone)}–${localHHMM(p.end, timeZone)}`);
  return [head, ...next].join(' · ');
}
