import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BatteryAction, PlannedInterval } from '../lib/planner/planner.js';
import { liveState, planPeriods, planSummary } from '../lib/planner/summary.js';
import { TZ } from './helpers.js';

/** spec: [action, quarters, SOC at start, battery kWh per quarter (+ charging)] */
function plan(start: string, spec: Array<[BatteryAction, number, number, number?]>): PlannedInterval[] {
  const out: PlannedInterval[] = [];
  let t = new Date(start).getTime();
  for (const [action, quarters, soc, kwh = 0] of spec) {
    for (let i = 0; i < quarters; i++, t += 900_000) {
      out.push({
        start: new Date(t), end: new Date(t + 900_000), buy: 3, sell: 1, action,
        socStartPct: soc, socEndPct: soc, gridKwh: 0, batteryKwh: kwh, storedEnergyValue: 0,
      });
    }
  }
  return out;
}

const RESERVE = 25;
const MAX = 100;

describe('planPeriods', () => {
  it('names every period by what powers what (24–25 Sep plan)', () => {
    const day = plan('2026-09-24T18:45:00+02:00', [
      ['self_use', 9, 61, -0.6], // battery powers the house until 21:00
      ['self_use', 48, 26, 0], // at reserve overnight
      ['self_use', 12, 26, 0.3], // solar charging 09:00–12:00
      ['charge', 7, 34, 1.5], // grid charging 12:00–13:45
      ['hold', 8, 84, 0], // saving 13:45–15:45
    ]);
    const periods = planPeriods(day, RESERVE, MAX).map((p) => p.state);
    assert.deepEqual(periods, ['battery', 'at_reserve', 'solar_charge', 'grid_charge', 'save']);
  });

  it('merges short dips into the surrounding period but keeps planned charging', () => {
    const day = plan('2026-09-25T09:00:00+02:00', [
      ['self_use', 8, 30, 0.3], // solar charging
      ['self_use', 1, 32, -0.1], // 15 min dip
      ['self_use', 8, 32, 0.3], // solar charging
      ['charge', 1, 40, 1.5], // 15 min planned charge: kept
    ]);
    assert.deepEqual(planPeriods(day, RESERVE, MAX).map((p) => p.state), ['solar_charge', 'grid_charge']);
  });

  it('names a resting battery above the reserve by what powers the house (25 Sep noon)', () => {
    // 68 %, forecast solar just covers the house: the battery rests; it is not at the reserve.
    const noon = plan('2026-09-25T12:30:00+02:00', [['self_use', 4, 68, 0]]);
    assert.equal(planPeriods(noon, RESERVE, MAX)[0].state, 'solar_house');
    assert.equal(liveState('at_reserve', { socPct: 68, batteryW: 0, gridW: 20 }, RESERVE, MAX), 'solar_house');
  });

  it('recognises a full battery with solar covering the house', () => {
    const day = plan('2026-07-01T11:00:00+02:00', [['self_use', 8, 100, 0]]);
    assert.equal(planPeriods(day, RESERVE, MAX)[0].state, 'full');
  });
});

describe('planSummary', () => {
  const evening = plan('2026-09-24T18:15:00+02:00', [['self_use', 11, 61, -0.6], ['self_use', 60, 26, 0], ['charge', 7, 30, 1.5]]);

  it('says what happens now and the next planned actions', () => {
    assert.equal(planSummary(evening, new Date('2026-09-24T18:16:00+02:00'), RESERVE, MAX, TZ),
      'Battery powers house until 21:00 · Grid charging 12:00–13:45');
    assert.equal(planSummary(evening, new Date('2026-09-24T18:16:00+02:00'), RESERVE, MAX, TZ, 'sv'),
      'Batteriet driver huset till 21:00 · Nätladdning 12:00–13:45');
  });

  it('hides saves too close to the reserve', () => {
    const idle = plan('2026-09-24T22:00:00+02:00', [['self_use', 4, 29, -0.3], ['hold', 8, 27]]);
    assert.equal(planSummary(idle, new Date('2026-09-24T22:00:00+02:00'), RESERVE, MAX, TZ), 'Battery powers house until 23:00');
  });
});

describe('live state', () => {
  it('shows what really happens in a self-use period (25 Sep morning)', () => {
    // Planned at reserve until 10:00, but the sun came out: the battery charges from solar.
    const morning = plan('2026-09-25T08:45:00+02:00', [['self_use', 5, 25, 0], ['self_use', 8, 25, 0.3], ['charge', 7, 40, 1.5]]);
    const now = new Date('2026-09-25T08:57:00+02:00');
    assert.equal(planSummary(morning, now, RESERVE, MAX, TZ, 'en', { socPct: 25, batteryW: 1650 }),
      'Solar charging now · Grid charging 12:00–13:45');
    assert.equal(planSummary(morning, now, RESERVE, MAX, TZ, 'en', { socPct: 25, batteryW: 0 }),
      'At reserve · grid powers house until 10:00 · Grid charging 12:00–13:45', 'as planned');
  });

  it('never overrides planned charging or saving', () => {
    assert.equal(liveState('grid_charge', { socPct: 50, batteryW: 0 }, RESERVE, MAX), null);
    assert.equal(liveState('save', { socPct: 50, batteryW: -2000 }, RESERVE, MAX), null);
    assert.equal(liveState('at_reserve', { socPct: 60, batteryW: -2000 }, RESERVE, MAX), 'battery');
    assert.equal(liveState('battery', { socPct: 60, batteryW: 0 }, RESERVE, MAX), null, 'idle mid-range: undecided');
  });
});
