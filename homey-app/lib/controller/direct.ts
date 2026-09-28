import type { DirectCommand } from '../inverter/types.js';
import type { PlannedInterval } from '../planner/planner.js';
import { isPointlessSave } from '../planner/summary.js';

/** The command for now, and when the plan next asks for a different one (null: not within the plan). */
export interface DirectStep {
  command: DirectCommand;
  until: Date | null;
}

export interface DirectOptions {
  reserveSoc: number;
  maxSoc: number;
  /** The battery's level now, from live data; a charge that has reached its target stops charging. */
  socPct?: number | null;
  /**
   * The inverter holds now (the last command). A charge block that has reached its target then only
   * charges again when the level has dropped by RECHARGE_BELOW_PCT: SolisCloud's level moves between
   * 99 and 100 % at the top, which otherwise switched hold and charge back and forth (28 Sep 04:49).
   */
  holding?: boolean;
}

/** How far below its target a finished charge block must drop before it charges again. */
export const RECHARGE_BELOW_PCT = 3;

const OFF: DirectCommand = { kind: 'off' };

/**
 * Turns the plan into the command for direct control (Remote Dispatch) at `now`:
 *
 * - charge: at the block's lowest planned power, up to the block's final level;
 * - hold: standby, except in a quarter where the plan expects surplus solar. Standby would export
 *   that surplus (verified 27 Sep 2026), while self-use stores it and does not discharge;
 * - a charge that has reached its target behaves like a hold, since a dispatch charge sitting at its
 *   upper level also exports surplus solar;
 * - self-use, and holds at the reserve (they keep nothing): off.
 */
export function directStep(plan: PlannedInterval[], now: Date, opts: DirectOptions): DirectStep {
  const i = plan.findIndex((iv) => iv.start <= now && iv.end > now);
  if (i < 0) return { command: OFF, until: null };
  const command = commandAt(plan, i, opts, opts.socPct ?? null);
  let j = i + 1;
  // Later quarters are judged without live data: the planned levels say when the command changes.
  while (j < plan.length && plan[j].start.getTime() === plan[j - 1].end.getTime()
    && sameCommand(commandAt(plan, j, opts, null), command)) j++;
  return { command, until: j < plan.length ? plan[j].start : plan[plan.length - 1].end };
}

export function sameCommand(a: DirectCommand, b: DirectCommand): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'charge' && b.kind === 'charge') return a.powerW === b.powerW && a.targetSoc === b.targetSoc;
  return true;
}

export function describeCommand(c: DirectCommand): string {
  if (c.kind === 'charge') return `charge ${(c.powerW / 1000).toFixed(1)} kW to ${c.targetSoc} %`;
  return c.kind === 'hold' ? 'hold' : 'off';
}

/**
 * Failsafe for a command: until the plan's next change plus a margin, so the inverter goes back to
 * its own mode by itself if the app stops, but never ends a block early. Minutes, 1–1440.
 */
export function failsafeMinutes(step: DirectStep, now: Date, marginMin = 10): number {
  if (!step.until) return 60;
  const minutes = Math.ceil((step.until.getTime() - now.getTime()) / 60_000) + marginMin;
  return Math.min(1440, Math.max(1, minutes));
}

function commandAt(plan: PlannedInterval[], i: number, opts: DirectOptions, socPct: number | null): DirectCommand {
  const iv = plan[i];
  if (iv.action === 'charge') {
    // The whole charge block: its final level is the target, its lowest power the rate.
    let end = i;
    while (end + 1 < plan.length && plan[end + 1].action === 'charge' && plan[end + 1].start.getTime() === plan[end].end.getTime()) end++;
    let start = i;
    while (start > 0 && plan[start - 1].action === 'charge' && plan[start - 1].end.getTime() === plan[start].start.getTime()) start--;
    const block = plan.slice(start, end + 1);
    const targetSoc = Math.min(opts.maxSoc, Math.ceil(plan[end].socEndPct));
    const kw = Math.min(...block.map((b) => b.chargeKw).filter((k) => k > 0));
    const margin = socPct !== null && opts.holding ? RECHARGE_BELOW_PCT : 0.5;
    const reached = (socPct ?? iv.socStartPct) >= targetSoc - margin;
    if (!reached && Number.isFinite(kw)) return { kind: 'charge', powerW: Math.round(kw * 100) * 10, targetSoc };
    return holdOrSelfUse(iv);
  }
  if (iv.action === 'hold') {
    return isPointlessSave(iv.action, iv.socStartPct, opts.reserveSoc) ? OFF : holdOrSelfUse(iv);
  }
  return OFF;
}

/** Standby, unless the plan expects surplus solar in this quarter: then self-use stores it. */
function holdOrSelfUse(iv: PlannedInterval): DirectCommand {
  const surplus = iv.gridKwh < -0.01 || (iv.action === 'hold' && iv.batteryKwh > 0.01);
  return surplus ? OFF : { kind: 'hold' };
}
