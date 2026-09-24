import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BatteryAction, PlannedInterval } from '../lib/planner/planner.js';
import { planSummary } from '../lib/planner/summary.js';
import { TZ } from './helpers.js';

function plan(start: string, spec: Array<[BatteryAction, number, number]>): PlannedInterval[] {
  // spec: [action, quarters, SOC at start]
  const out: PlannedInterval[] = [];
  let t = new Date(start).getTime();
  for (const [action, quarters, soc] of spec) {
    for (let i = 0; i < quarters; i++, t += 900_000) {
      out.push({ start: new Date(t), end: new Date(t + 900_000), buy: 3, sell: 1, action, socStartPct: soc, socEndPct: soc, gridKwh: 0, batteryKwh: 0, storedEnergyValue: 0 });
    }
  }
  return out;
}

function withBattery(intervals: PlannedInterval[], kwhPerQuarter: number, from: number, to: number): PlannedInterval[] {
  return intervals.map((iv, i) => (i >= from && i < to ? { ...iv, batteryKwh: kwhPerQuarter } : iv));
}

describe('planSummary', () => {
  // 24 Sep 18:15: self-use until 21:45, then save overnight until 07:15 (crosses midnight).
  const evening = plan('2026-09-24T18:15:00+02:00', [['self_use', 14, 67], ['hold', 38, 40], ['self_use', 8, 40]]);

  it('merges periods across midnight and starts with what happens now', () => {
    assert.equal(planSummary(evening, new Date('2026-09-24T18:16:00+02:00'), 25, TZ), 'Self-use now · Save 21:45–07:15');
    assert.equal(planSummary(evening, new Date('2026-09-24T18:16:00+02:00'), 25, TZ, 'sv'), 'Egenanvändning nu · Spara 21:45–07:15');
  });

  it('names periods where the battery covers the house', () => {
    const evening2 = withBattery(evening, -0.6, 0, 14); // 2.4 kW out of the battery until 21:45
    assert.equal(planSummary(evening2, new Date('2026-09-24T18:16:00+02:00'), 25, TZ), 'Use battery until 21:45 · Save 21:45–07:15');
  });

  it('leaves out brief dips where the battery helps a little', () => {
    const morning = withBattery(plan('2026-09-25T09:00:00+02:00', [['self_use', 16, 26]]), -0.1, 0, 2); // 0.2 kWh in 30 min
    assert.equal(planSummary(morning, new Date('2026-09-25T09:00:00+02:00'), 25, TZ), 'Self-use now · no charging or saving needed');
  });

  it('says until when the current action lasts', () => {
    const night = plan('2026-09-25T02:00:00+02:00', [['charge', 13, 30], ['hold', 7, 80], ['self_use', 4, 80]]);
    assert.equal(planSummary(night, new Date('2026-09-25T02:05:00+02:00'), 25, TZ), 'Charge until 05:15 · Save 05:15–07:00');
  });

  it('hides saves at the reserve level and says when nothing is planned', () => {
    const idle = plan('2026-09-24T22:00:00+02:00', [['self_use', 4, 29], ['hold', 8, 27]]); // 2 points above the reserve
    assert.equal(planSummary(idle, new Date('2026-09-24T22:00:00+02:00'), 25, TZ), 'Self-use now · no charging or saving needed');
  });
});
