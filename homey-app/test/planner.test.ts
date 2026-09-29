import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type BatteryAction, planBattery, type PlanInput } from '../lib/planner/planner.js';
import { intervals, quarters } from './helpers.js';

const base: Omit<PlanInput, 'intervals'> = {
  socPct: 30,
  capacityKwh: 21.68,
  reserveSocPct: 25,
  maxSocPct: 100,
  maxChargeKw: 6.5,
  maxDischargeKw: 10,
  roundTripEfficiency: 0.9,
  cyclingCostPerKwh: 0.2,
  minGainPerKwh: 0.1,
};

// Shaped like 23 Sep 2026 in SE3: cheap night, morning peak, evening peak.
const DAY = quarters([
  2.7, 2.7, 2.7, 2.7, 2.7, 2.8, 3.1, 4.2, 4.3, 3.8, 3.0, 2.7,
  2.6, 2.5, 2.5, 2.5, 2.7, 3.2, 3.9, 4.1, 4.0, 3.2, 2.5, 2.3,
]);

const actionsOf = (plan: ReturnType<typeof planBattery>, from: number, to: number): Set<BatteryAction> =>
  new Set(plan.intervals.slice(from, to).map((iv) => iv.action));

describe('planBattery', () => {
  it('does nothing special when prices are flat', () => {
    const plan = planBattery({ ...base, intervals: intervals('2026-09-24T00:00:00+02:00', Array(96).fill(3)) });
    assert.ok(plan.intervals.every((iv) => iv.action !== 'charge'));
    assert.ok(Math.abs(plan.savingsSek) < 0.01);
  });

  it('keeps a running charge when charging now or later costs the same', () => {
    // Flat cheap hours, then expensive ones: when to charge is a tie (27 Sep 12:57).
    const prices = [...Array(16).fill(1.18), ...Array(32).fill(3)];
    const from = (initialAction: BatteryAction) =>
      planBattery({ ...base, initialAction, intervals: intervals('2026-09-24T12:00:00+02:00', prices) }).intervals[0].action;
    assert.equal(from('charge'), 'charge');
  });

  it('keeps grid charging within the import limit (main fuse)', () => {
    // Cheap first hour, then expensive: charge at full power unless the house leaves less room.
    const prices = [...Array(4).fill(1), ...Array(44).fill(3)];
    const busy = intervals('2026-09-29T01:00:00+02:00', prices, 11); // 11 kW house load
    const plan = planBattery({ ...base, maxImportKw: 15, intervals: busy });
    assert.ok(plan.intervals[0].action === 'charge');
    assert.ok(Math.abs(plan.intervals[0].chargeKw - 4) < 1e-9, `charges at 15 - 11 = 4 kW, not ${plan.intervals[0].chargeKw}`);
    const calm = planBattery({ ...base, maxImportKw: 15, intervals: intervals('2026-09-29T01:00:00+02:00', prices, 2) });
    assert.equal(calm.intervals[0].chargeKw, 6.5, 'room enough: full power');
  });

  it('does not charge a battery that sits exactly at the reserve', () => {
    // 25 % of 21.68 kWh is 5.42 kWh, between two 0.05 kWh steps of the planner.
    const plan = planBattery({ ...base, socPct: 25, intervals: intervals('2026-09-24T00:00:00+02:00', Array(96).fill(3)) });
    assert.ok(plan.intervals.every((iv) => iv.action !== 'charge'));
    assert.ok(Math.abs(plan.savingsSek) < 0.01);
  });

  it('charges in the cheap night and uses the battery in the peaks', () => {
    const plan = planBattery({ ...base, intervals: intervals('2026-09-24T00:00:00+02:00', DAY) });
    assert.ok(actionsOf(plan, 0, 24).has('charge'), 'charges before the morning peak');
    assert.deepEqual(actionsOf(plan, 72, 84), new Set(['self_use']), 'self-use in the evening peak');
    assert.ok(plan.savingsSek > 5, `savings ${plan.savingsSek}`);
    const evening = plan.intervals[80];
    assert.ok(evening.socStartPct > evening.socEndPct, 'battery discharges in the evening peak');
  });

  it('skips grid charging when the spread does not cover losses and wear', () => {
    const small = quarters(Array.from({ length: 24 }, (_, h) => (h < 6 ? 3.0 : 3.25)));
    const plan = planBattery({ ...base, intervals: intervals('2026-09-24T00:00:00+02:00', small) });
    assert.ok(plan.intervals.every((iv) => iv.action !== 'charge'));
  });

  it('never plans the battery below the reserve in self-use', () => {
    const plan = planBattery({ ...base, socPct: 60, intervals: intervals('2026-09-24T00:00:00+02:00', Array(96).fill(4)) });
    const minSoc = Math.min(...plan.intervals.map((iv) => iv.socEndPct));
    assert.ok(minSoc >= 25 - 0.3, `min SOC ${minSoc}`);
  });

  it('restores the reserve quickly when below it', () => {
    const plan = planBattery({ ...base, socPct: 14, intervals: intervals('2026-09-24T18:00:00+02:00', DAY.slice(72)) });
    assert.equal(plan.intervals[0].action, 'charge');
    assert.ok(plan.intervals[4].socEndPct >= 24, `SOC after 1.25 h: ${plan.intervals[4].socEndPct}`);
  });

  it('values stored energy at what it costs to replace', () => {
    const plan = planBattery({ ...base, socPct: 60, intervals: intervals('2026-09-24T00:00:00+02:00', DAY) });
    const peak = plan.intervals[32]; // 08:00, 4.3 kr/kWh
    // Energy used now can be recharged at night/midday prices (about 2.5 / 0.95 + margins).
    assert.ok(peak.storedEnergyValue > 2.5 && peak.storedEnergyValue < 3.0, `peak value ${peak.storedEnergyValue}`);
    assert.ok(peak.storedEnergyValue < peak.buy, 'cheaper than buying at the peak');
  });

  it('values stored energy close to the peak price when it cannot be replaced', () => {
    // No grid charging possible: a kWh used before the evening peak must be bought at the peak.
    const plan = planBattery({ ...base, socPct: 50, maxChargeKw: 0.01, intervals: intervals('2026-09-24T12:00:00+02:00', DAY.slice(48)) });
    const beforePeak = plan.intervals[20]; // 17:00
    assert.ok(beforePeak.storedEnergyValue > 3.2, `value ${beforePeak.storedEnergyValue}`); // peak price less losses and wear
  });

  it('respects fixed actions', () => {
    const fixed = new Map<number, BatteryAction>([[0, 'hold'], [1, 'hold']]);
    const plan = planBattery({ ...base, socPct: 80, fixedActions: fixed, intervals: intervals('2026-09-24T07:00:00+02:00', DAY.slice(28)) });
    assert.equal(plan.intervals[0].action, 'hold');
    assert.equal(plan.intervals[1].action, 'hold');
    assert.equal(plan.intervals[1].socEndPct, 80);
  });

  it('holds charge through cheap hours when that saves it for a later peak', () => {
    // Full battery at night; the house load until the peak would otherwise drain it.
    const prices = quarters([2.2, 2.2, 2.2, 2.2, 2.2, 2.2, 2.2, 2.2, 2.2, 2.2, 4.3, 4.3]);
    const plan = planBattery({ ...base, socPct: 60, maxChargeKw: 0.5, intervals: intervals('2026-09-24T00:00:00+02:00', prices) });
    assert.ok(actionsOf(plan, 0, 40).has('hold'));
    assert.deepEqual(actionsOf(plan, 40, 48), new Set(['self_use']));
  });
});
