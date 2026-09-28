import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeCommand, directStep, failsafeMinutes } from '../lib/controller/direct.js';
import { type BatteryAction, type PlannedInterval, planBattery } from '../lib/planner/planner.js';
import { intervals } from './helpers.js';

const T0 = new Date('2026-09-27T12:00:00+02:00').getTime();
const at = (quarter: number, minute = 5) => new Date(T0 + quarter * 900_000 + minute * 60_000);

/** A plan from quarters: [action, socStart, socEnd, chargeKw?, gridKwh?, batteryKwh?]. */
function plan(rows: Array<[BatteryAction, number, number, number?, number?, number?]>): PlannedInterval[] {
  return rows.map(([action, socStartPct, socEndPct, chargeKw = 0, gridKwh = 0.5, batteryKwh = 0], i) => ({
    start: new Date(T0 + i * 900_000),
    end: new Date(T0 + (i + 1) * 900_000),
    buy: 1, sell: 0.5, action, socStartPct, socEndPct, gridKwh, batteryKwh, chargeKw, storedEnergyValue: 0,
  }));
}

const opts = { reserveSoc: 25, maxSoc: 100 };

describe('direct control from the plan', () => {
  const day = plan([
    ['self_use', 40, 38],
    ['charge', 38, 45, 6.5, 2],
    ['charge', 45, 52, 6.0, 2],
    ['charge', 52, 60, 6.5, 2],
    ['hold', 60, 60],
    ['hold', 60, 60],
    ['self_use', 60, 58],
  ]);

  it('charges a block at its lowest power up to its final level, until the block ends', () => {
    const step = directStep(day, at(1), { ...opts, socPct: 39 });
    assert.deepEqual(step.command, { kind: 'charge', powerW: 6000, targetSoc: 60 });
    assert.deepEqual(step.until, day[4].start);
    assert.equal(describeCommand(step.command), 'charge 6.0 kW to 60 %');
  });

  it('holds with standby, and is off in self-use', () => {
    assert.deepEqual(directStep(day, at(4), opts), { command: { kind: 'hold' }, until: day[6].start });
    assert.deepEqual(directStep(day, at(0), opts), { command: { kind: 'off' }, until: day[1].start });
    assert.deepEqual(directStep(day, at(6), opts).command, { kind: 'off' });
  });

  it('stops charging once the target is reached, without holding back surplus solar', () => {
    assert.deepEqual(directStep(day, at(3), { ...opts, socPct: 60 }).command, { kind: 'hold' });
    const sunny = plan([['charge', 58, 60, 6.5, -0.4]]);
    assert.deepEqual(directStep(sunny, at(0), { ...opts, socPct: 60 }).command, { kind: 'off' }, 'surplus: self-use stores it');
  });

  it('does not start charging again when the level wobbles at the top (28 Sep 04:49)', () => {
    const charge = plan([['charge', 94, 97, 6.5, 2], ['charge', 97, 100, 6.5, 2]]);
    assert.deepEqual(directStep(charge, at(1), { ...opts, socPct: 100 }).command, { kind: 'hold' }, 'reached: hold');
    assert.deepEqual(directStep(charge, at(1), { ...opts, socPct: 99, holding: true }).command, { kind: 'hold' }, '99 %: still hold');
    assert.equal(directStep(charge, at(1), { ...opts, socPct: 96, holding: true }).command.kind, 'charge', 'dropped: charge again');
    assert.equal(directStep(charge, at(1), { ...opts, socPct: 99 }).command.kind, 'charge', 'not reached yet: charge to the end');
  });

  it('lets surplus solar charge the battery during a daytime hold', () => {
    const sunnyHold = plan([['hold', 60, 61, 0, 0, 0.3], ['hold', 61, 61]]);
    assert.deepEqual(directStep(sunnyHold, at(0), opts), { command: { kind: 'off' }, until: sunnyHold[1].start });
    assert.deepEqual(directStep(sunnyHold, at(1), opts).command, { kind: 'hold' });
  });

  it('does not hold at the reserve (nothing to keep)', () => {
    assert.deepEqual(directStep(plan([['hold', 25, 25]]), at(0), opts).command, { kind: 'off' });
  });

  it('is off outside the plan', () => {
    assert.deepEqual(directStep(day, at(20), opts), { command: { kind: 'off' }, until: null });
  });

  it('keeps the failsafe until the block ends plus a margin, within 1-1440 minutes', () => {
    const now = at(1, 0);
    assert.equal(failsafeMinutes({ command: { kind: 'hold' }, until: new Date(now.getTime() + 45 * 60_000) }, now), 55);
    assert.equal(failsafeMinutes({ command: { kind: 'hold' }, until: new Date(now.getTime() + 30 * 3_600_000) }, now), 1440);
    assert.equal(failsafeMinutes({ command: { kind: 'hold' }, until: null }, now), 60);
  });
});

describe('planner with direct control', () => {
  it('lets a hold store surplus solar', () => {
    const ivs = intervals('2026-09-27T10:00:00+02:00', [1, 1, 1, 1], 1).map((iv) => ({ ...iv, pvKw: 4 }));
    const base = {
      intervals: ivs, socPct: 50, capacityKwh: 21.68, reserveSocPct: 25, maxSocPct: 100, maxChargeKw: 6.5,
      maxDischargeKw: 10, roundTripEfficiency: 0.9, cyclingCostPerKwh: 0.2, minGainPerKwh: 0.1,
      fixedActions: new Map<number, BatteryAction>([[0, 'hold']]),
    };
    assert.equal(planBattery(base).intervals[0].batteryKwh, 0, 'slots: a hold exports the surplus');
    assert.ok(planBattery({ ...base, holdStoresSurplus: true }).intervals[0].batteryKwh > 0.6, 'direct: it is stored');
  });
});
