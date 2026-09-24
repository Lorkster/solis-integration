import { DISABLED_SLOT, type TouSlot } from '../inverter/types.js';
import { addDays, localDate, localHHMM } from '../time.js';
import type { BatteryAction, PlannedInterval } from './planner.js';
import { isPointlessSave } from './summary.js';

export interface ScheduleOptions {
  now: Date;
  timeZone: string;
  batteryVoltageV: number;
  maxChargeKw: number;
  maxSocPct: number;
  slotCount: number; // charge slots available on the inverter (6 on TOU v2 firmware)
  /** Holds starting at or near this SOC keep nothing the reserve does not already keep. */
  reserveSocPct?: number;
}

export interface Schedule {
  chargeSlots: TouSlot[];
  warnings: string[];
}

interface Block {
  action: Exclude<BatteryAction, 'self_use'>;
  start: Date;
  end: Date;
  socStartPct: number;
  socEndPct: number;
  chargeKw: number; // lowest planned charge power in the block
}

/**
 * Converts the next 24 hours of a plan into inverter charge slots.
 *
 * Slots repeat daily and carry no date, so only [now, now + 24h) can be expressed. The plan is
 * rewritten at least daily, which keeps the repeating slots aligned with the latest prices; if
 * the app stops, the inverter keeps repeating the last schedule, which is a safe fallback.
 *
 * "hold" is expressed as a charge slot with 0 A: while a charge slot is active the inverter does
 * not discharge, so the house runs on grid power and the battery keeps its energy.
 * Verified on an S6-EH3P20K-H (TOU v2) on 24 Sep 2026: a 0 A charge slot holds the battery.
 */
export function planToSchedule(plan: PlannedInterval[], opts: ScheduleOptions): Schedule {
  const warnings: string[] = [];
  const horizonEnd = addDays(opts.now, 1);
  const pointlessHold = (b: Block) => opts.reserveSocPct !== undefined && isPointlessSave(b.action, b.socStartPct, opts.reserveSocPct);
  let blocks = splitAtMidnight(
    toBlocks(plan.filter((iv) => iv.end > opts.now && iv.start < horizonEnd)).filter((b) => !pointlessHold(b)),
    opts.timeZone,
  );

  while (blocks.length > opts.slotCount) {
    const holds = blocks.filter((b) => b.action === 'hold');
    if (holds.length > 0) {
      const shortest = holds.reduce((a, b) => (duration(a) <= duration(b) ? a : b));
      blocks = blocks.filter((b) => b !== shortest);
      warnings.push(`Dropped hold ${localHHMM(shortest.start, opts.timeZone)}–${localHHMM(shortest.end, opts.timeZone)}: not enough slots`);
    } else {
      blocks = mergeClosestCharges(blocks, opts.timeZone, warnings);
    }
  }

  const currentFor = (kw: number) => Math.ceil(Math.min(kw, opts.maxChargeKw) * 1000 / Math.max(opts.batteryVoltageV, 1));
  const chargeSlots: TouSlot[] = blocks.map((b) => ({
    enabled: true,
    start: localHHMM(b.start, opts.timeZone),
    end: slotEnd(b.end, opts.timeZone),
    currentA: b.action === 'charge' ? Math.max(1, currentFor(b.chargeKw)) : 0,
    soc: b.action === 'charge'
      ? Math.min(opts.maxSocPct, Math.ceil(b.socEndPct))
      : Math.max(0, Math.round(b.socStartPct)),
  }));
  while (chargeSlots.length < opts.slotCount) chargeSlots.push({ ...DISABLED_SLOT });
  return { chargeSlots, warnings };
}

function toBlocks(plan: PlannedInterval[]): Block[] {
  const blocks: Block[] = [];
  for (const iv of plan) {
    if (iv.action === 'self_use') continue;
    const last = blocks[blocks.length - 1];
    const chargeKw = iv.action === 'charge' ? iv.chargeKw ?? Infinity : 0;
    if (last && last.action === iv.action && last.end.getTime() === iv.start.getTime()) {
      last.end = iv.end;
      last.socEndPct = iv.socEndPct;
      last.chargeKw = Math.min(last.chargeKw, chargeKw);
    } else {
      blocks.push({ action: iv.action, start: iv.start, end: iv.end, socStartPct: iv.socStartPct, socEndPct: iv.socEndPct, chargeKw });
    }
  }
  return blocks;
}

/** Slots are "HH:MM-HH:MM" within one day, so a block crossing local midnight becomes two. */
function splitAtMidnight(blocks: Block[], timeZone: string): Block[] {
  const result: Block[] = [];
  for (const block of blocks) {
    let current = block;
    for (;;) {
      const midnight = nextLocalMidnight(current.start, timeZone);
      if (current.end <= midnight) {
        result.push(current);
        break;
      }
      result.push({ ...current, end: midnight });
      current = { ...current, start: midnight };
    }
  }
  return result;
}

function nextLocalMidnight(date: Date, timeZone: string): Date {
  // Step forward in 15-minute increments until the local date changes (handles DST shifts).
  const day = localDate(date, timeZone);
  let probe = new Date(Math.floor(date.getTime() / 900_000) * 900_000 + 900_000);
  while (localDate(probe, timeZone) === day) probe = new Date(probe.getTime() + 900_000);
  return probe;
}

function slotEnd(end: Date, timeZone: string): string {
  const hhmm = localHHMM(end, timeZone);
  return hhmm === '00:00' ? '23:59' : hhmm;
}

function duration(b: Block): number {
  return b.end.getTime() - b.start.getTime();
}

function mergeClosestCharges(blocks: Block[], timeZone: string, warnings: string[]): Block[] {
  let bestIndex = -1;
  let bestGap = Infinity;
  for (let i = 0; i < blocks.length - 1; i++) {
    const sameDay = localDate(blocks[i].start, timeZone) === localDate(blocks[i + 1].start, timeZone);
    const gap = blocks[i + 1].start.getTime() - blocks[i].end.getTime();
    if (sameDay && gap < bestGap) {
      bestGap = gap;
      bestIndex = i;
    }
  }
  if (bestIndex < 0) {
    warnings.push('More charge blocks than slots; dropped the last one');
    return blocks.slice(0, -1);
  }
  const a = blocks[bestIndex];
  const b = blocks[bestIndex + 1];
  warnings.push(`Merged charge blocks at ${localHHMM(a.start, timeZone)} and ${localHHMM(b.start, timeZone)}`);
  const merged: Block = {
    action: 'charge', start: a.start, end: b.end, socStartPct: a.socStartPct, socEndPct: b.socEndPct, chargeKw: Math.min(a.chargeKw, b.chargeKw),
  };
  return [...blocks.slice(0, bestIndex), merged, ...blocks.slice(bestIndex + 2)];
}
