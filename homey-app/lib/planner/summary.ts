import { localHHMM } from '../time.js';
import type { BatteryAction, PlannedInterval } from './planner.js';

export type Language = 'en' | 'sv';

const WORDS = {
  en: { charge: 'Charge', hold: 'Save', self_use: 'Self-use', now: 'now', until: 'until', none: 'no charging or saving needed' },
  sv: { charge: 'Ladda', hold: 'Spara', self_use: 'Egenanvändning', now: 'nu', until: 'till', none: 'ingen laddning eller sparning behövs' },
};

/**
 * Display action of an interval. A "save" that starts at the reserve keeps nothing the reserve
 * does not already keep; it is not sent to the inverter, so it is shown as self-use.
 */
export function displayAction(iv: PlannedInterval, reserveSoc: number): BatteryAction {
  return iv.action === 'hold' && iv.socStartPct <= reserveSoc + 1.5 ? 'self_use' : iv.action;
}

interface Block {
  action: BatteryAction;
  start: Date;
  end: Date;
}

function blocks(intervals: PlannedInterval[], reserveSoc: number): Block[] {
  const out: Block[] = [];
  for (const iv of intervals) {
    const action = displayAction(iv, reserveSoc);
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
