import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BatteryAction, PlannedInterval } from '../lib/planner/planner.js';
import { planToSchedule } from '../lib/planner/schedule.js';
import { TZ } from './helpers.js';

function plan(start: string, actions: BatteryAction[]): PlannedInterval[] {
  const t0 = new Date(start).getTime();
  let soc = 20;
  return actions.map((action, i) => {
    const socStartPct = soc;
    if (action === 'charge') soc += 7;
    return {
      start: new Date(t0 + i * 900_000),
      end: new Date(t0 + (i + 1) * 900_000),
      buy: 3,
      sell: 1,
      action,
      socStartPct,
      socEndPct: soc,
      gridKwh: 0,
      batteryKwh: 0,
      storedEnergyValue: 0,
    };
  });
}

const opts = (now: string) => ({
  now: new Date(now),
  timeZone: TZ,
  batteryVoltageV: 420,
  maxChargeKw: 6.5,
  maxSocPct: 100,
  slotCount: 6,
});

describe('planToSchedule', () => {
  it('turns charge and hold blocks into slots', () => {
    const actions: BatteryAction[] = [
      ...Array(8).fill('charge'), // 02:00-04:00
      ...Array(8).fill('hold'), // 04:00-06:00
      ...Array(8).fill('self_use'),
    ];
    const { chargeSlots, warnings } = planToSchedule(plan('2026-09-24T02:00:00+02:00', actions), opts('2026-09-24T01:00:00+02:00'));
    assert.deepEqual(warnings, []);
    assert.deepEqual(chargeSlots[0], { enabled: true, start: '02:00', end: '04:00', currentA: 16, soc: 76 });
    assert.deepEqual(chargeSlots[1], { enabled: true, start: '04:00', end: '06:00', currentA: 0, soc: 76 });
    assert.equal(chargeSlots.length, 6);
    assert.ok(chargeSlots.slice(2).every((s) => !s.enabled));
  });

  it('skips holds that start at the reserve', () => {
    const actions: BatteryAction[] = [...Array(4).fill('hold'), ...Array(4).fill('self_use')];
    const intervals = plan('2026-09-24T21:00:00+02:00', actions); // SOC 20 %
    assert.equal(planToSchedule(intervals, { ...opts('2026-09-24T20:00:00+02:00'), reserveSocPct: 20 }).chargeSlots.filter((s) => s.enabled).length, 0);
    assert.equal(planToSchedule(intervals, { ...opts('2026-09-24T20:00:00+02:00'), reserveSocPct: 10 }).chargeSlots.filter((s) => s.enabled).length, 1);
  });

  it('splits blocks at local midnight and uses 23:59 as end of day', () => {
    const actions: BatteryAction[] = Array(8).fill('charge'); // 23:00-01:00
    const { chargeSlots } = planToSchedule(plan('2026-09-24T23:00:00+02:00', actions), opts('2026-09-24T22:00:00+02:00'));
    assert.equal(chargeSlots[0].start, '23:00');
    assert.equal(chargeSlots[0].end, '23:59');
    assert.equal(chargeSlots[1].start, '00:00');
    assert.equal(chargeSlots[1].end, '01:00');
  });

  it('only includes the next 24 hours', () => {
    const actions: BatteryAction[] = [...Array(96).fill('self_use'), ...Array(4).fill('charge')];
    const { chargeSlots } = planToSchedule(plan('2026-09-24T00:00:00+02:00', actions), opts('2026-09-24T00:00:00+02:00'));
    assert.ok(chargeSlots.every((s) => !s.enabled));
  });

  it('drops the shortest holds first when there are more blocks than slots', () => {
    const actions: BatteryAction[] = [];
    for (let i = 0; i < 4; i++) actions.push('charge', 'self_use', 'hold', ...(i === 0 ? ['hold' as const] : []), 'self_use');
    const { chargeSlots, warnings } = planToSchedule(plan('2026-09-24T00:00:00+02:00', actions), opts('2026-09-24T00:00:00+02:00'));
    assert.equal(chargeSlots.filter((s) => s.enabled).length, 6);
    assert.equal(chargeSlots.filter((s) => s.enabled && s.currentA > 0).length, 4, 'all charge blocks kept');
    assert.equal(warnings.length, 2);
  });
});
