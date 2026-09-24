import { localHHMM } from '../time.js';
import type { BatteryAction, PlannedInterval } from './planner.js';

export type Language = 'en' | 'sv';

export type DisplayState = BatteryAction | 'use';

const WORDS: Record<Language, Record<DisplayState | 'now' | 'until' | 'none', string>> = {
  en: { charge: 'Charge', hold: 'Save', use: 'Use battery', self_use: 'Self-use', now: 'now', until: 'until', none: 'no charging or saving needed' },
  sv: { charge: 'Ladda', hold: 'Spara', use: 'Använd batteri', self_use: 'Egenanvändning', now: 'nu', until: 'till', none: 'ingen laddning eller sparning behövs' },
};

/** A quarter-hour counts as "use" when the battery is planned to deliver at least this (kWh). */
const MIN_USE_KWH_PER_QUARTER = 0.05;

/**
 * A "save" only makes sense with a meaningful amount of energy above the reserve (5 percentage
 * points, about 1 kWh on a 21.7 kWh battery). Smaller saves are not sent to the inverter and are
 * shown as self-use.
 */
export const MIN_SAVE_ABOVE_RESERVE_PCT = 5;

export function isPointlessSave(action: BatteryAction, socStartPct: number, reserveSoc: number): boolean {
  return action === 'hold' && socStartPct < reserveSoc + MIN_SAVE_ABOVE_RESERVE_PCT;
}

/** Display action of an interval, with pointless saves shown as self-use. */
export function displayAction(iv: PlannedInterval, reserveSoc: number): BatteryAction {
  return isPointlessSave(iv.action, iv.socStartPct, reserveSoc) ? 'self_use' : iv.action;
}

/** Like displayAction, but self-use where the battery covers the house is "use". */
export function displayState(iv: PlannedInterval, reserveSoc: number): DisplayState {
  const action = displayAction(iv, reserveSoc);
  return action === 'self_use' && iv.batteryKwh <= -MIN_USE_KWH_PER_QUARTER ? 'use' : action;
}

interface Block {
  action: DisplayState;
  start: Date;
  end: Date;
}

function blocks(intervals: PlannedInterval[], reserveSoc: number): Block[] {
  const out: Block[] = [];
  for (const iv of intervals) {
    const action = displayState(iv, reserveSoc);
    const last = out[out.length - 1];
    if (last && last.action === action && last.end.getTime() === iv.start.getTime()) last.end = iv.end;
    else out.push({ action, start: iv.start, end: iv.end });
  }
  return out;
}

/**
 * One short line for the device tile: what the battery does now and the next planned periods,
 * e.g. "Self-use now · Save 21:45–07:15" or "Charge until 05:15 · Save 05:15–07:00".
 */
export function planSummary(
  intervals: PlannedInterval[],
  now: Date,
  reserveSoc: number,
  timeZone: string,
  language: Language = 'en',
): string {
  const w = WORDS[language];
  const upcoming = intervals.filter((iv) => iv.end > now && iv.start < new Date(now.getTime() + 86_400_000));
  if (upcoming.length === 0) return '';
  const [current, ...rest] = blocks(upcoming, reserveSoc);
  const head = current.action === 'self_use'
    ? `${w.self_use} ${w.now}`
    : `${w[current.action]} ${w.until} ${localHHMM(current.end, timeZone)}`;
  const next = rest.filter((b) => b.action !== 'self_use').slice(0, 2)
    .map((b) => `${w[b.action]} ${localHHMM(b.start, timeZone)}–${localHHMM(b.end, timeZone)}`);
  if (next.length === 0 && current.action === 'self_use') return `${head} · ${w.none}`;
  return [head, ...next].join(' · ');
}
