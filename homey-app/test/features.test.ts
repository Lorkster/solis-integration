import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NO_POWER_TARIFF, PeakTracker, peakWeight, type PowerTariffConfig } from '../lib/energy/PowerTariff.js';
import { SavingsTracker } from '../lib/energy/Savings.js';
import { deviationOf, PlanMonitor } from '../lib/inverter/PlanMonitor.js';
import { gridLost, PowerCutTracker } from '../lib/inverter/PowerCut.js';
import { planBattery, type PlanInterval } from '../lib/planner/planner.js';
import { TZ } from './helpers.js';

const ELLEVIO: PowerTariffConfig = {
  ...NO_POWER_TARIFF, enabled: true, pricePerKwMonth: 81.25, peaks: 3, fromHour: 6, toHour: 22, outsideWeight: 0.5,
};

describe('power cuts', () => {
  it('recognises a missing grid from voltage or status text', () => {
    assert.equal(gridLost({ uAc1: 229, uAc2: 230, uAc3: 231, fac: 50 }), false);
    assert.equal(gridLost({ uAc1: 0, uAc2: 0, uAc3: 0, fac: 50 }), true, 'off grid the frequency may be the inverter\'s own');
    assert.equal(gridLost({ uAc1: 230, faultCodeDesc: 'NO-Grid' }), true);
    assert.equal(gridLost({}), null);
  });

  it('reports start, low backup (once) and end', () => {
    const cut = new PowerCutTracker();
    const t = (m: number) => new Date(Date.UTC(2026, 9, 1, 12, m));
    assert.deepEqual(cut.update(t(0), false, 10), []);
    assert.deepEqual(cut.update(t(5), true, 8), ['started']);
    assert.deepEqual(cut.update(t(10), true, 1.5), ['backup_low']);
    assert.deepEqual(cut.update(t(15), true, 1.2), []);
    assert.deepEqual(cut.update(t(20), null, 1.2), [], 'unknown data changes nothing');
    assert.deepEqual(cut.update(t(25), false, 1.2), ['ended']);
    assert.equal(cut.active, false);
  });
});

describe('power fee', () => {
  it('weighs hours like the grid company', () => {
    assert.equal(peakWeight(new Date('2026-10-05T12:00:00+02:00'), TZ, ELLEVIO), 1);
    assert.equal(peakWeight(new Date('2026-10-05T23:00:00+02:00'), TZ, ELLEVIO), 0.5, 'night counts half');
    assert.equal(peakWeight(new Date('2026-07-05T12:00:00+02:00'), TZ, { ...ELLEVIO, winterOnly: true }), 0);
    assert.equal(peakWeight(new Date('2026-10-04T12:00:00+02:00'), TZ, { ...ELLEVIO, weekdaysOnly: true }), 0, 'Sunday');
    assert.equal(peakWeight(new Date('2026-10-05T12:00:00+02:00'), TZ, NO_POWER_TARIFF), 0);
  });

  it('keeps the highest peak per day and averages the top three', () => {
    const peaks = new PeakTracker(TZ, ELLEVIO);
    const hour = (day: number, h: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00+02:00`);
    peaks.record(hour(1, 18), 5);
    peaks.record(hour(1, 19), 6); // same day: only the highest counts
    peaks.record(hour(2, 18), 4);
    assert.equal(peaks.thresholdKw(), 4, 'fewer than three days: the lowest so far');
    peaks.record(hour(3, 18), 3);
    peaks.record(hour(4, 18), 2);
    assert.deepEqual(peaks.topPeaks(), [6, 4, 3]);
    assert.ok(Math.abs(peaks.feeLevelKw() - 13 / 3) < 1e-9);
    assert.equal(peaks.thresholdKw(), 3);
    peaks.record(new Date('2026-11-01T18:00:00+01:00'), 1);
    assert.deepEqual(peaks.topPeaks(), [1], 'a new month starts over');
  });

  it('measures hourly averages from samples and projects the current hour', () => {
    const peaks = new PeakTracker(TZ, ELLEVIO);
    const at = (m: number) => new Date(`2026-10-05T12:${String(m).padStart(2, '0')}:00+02:00`);
    for (let m = 0; m < 60; m += 5) peaks.addSample(at(m), m < 30 ? 2000 : 4000);
    peaks.addSample(new Date('2026-10-05T13:00:00+02:00'), 1000); // closes 12:00–13:00
    assert.ok(Math.abs(peaks.topPeaks()[0] - 3) < 1e-9);
    // 13:30, 1 kW so far, 5 kW now: half the hour left at 5 kW → 3 kW expected.
    assert.ok(Math.abs(peaks.projectedKw(new Date('2026-10-05T13:30:00+02:00'), 5000)! - 3) < 1e-9);
  });

  it('plans grid charging under the peak level', () => {
    const t0 = new Date('2026-10-05T10:00:00+02:00').getTime();
    const intervals: PlanInterval[] = Array.from({ length: 16 }, (_, i) => ({
      start: new Date(t0 + i * 900_000),
      end: new Date(t0 + (i + 1) * 900_000),
      buy: i < 8 ? 1 : 4, // cheap, then expensive
      sell: 0.5,
      loadKw: 2,
      pvKw: 0,
      peakWeight: 1,
    }));
    const input = {
      intervals, socPct: 30, capacityKwh: 20, reserveSocPct: 25, maxSocPct: 100, maxChargeKw: 8, maxDischargeKw: 10,
      roundTripEfficiency: 0.9, cyclingCostPerKwh: 0.1, minGainPerKwh: 0.05,
    };
    const free = planBattery(input);
    assert.ok(free.intervals.some((iv) => iv.action === 'charge' && iv.chargeKw === 8), 'full power without a power fee');
    const capped = planBattery({ ...input, peak: { costPerKw: 27, thresholdKw: 5, periodHours: 1 } });
    const charging = capped.intervals.filter((iv) => iv.action === 'charge');
    assert.ok(charging.length > 0, 'still charges when cheap');
    assert.ok(charging.every((iv) => iv.chargeKw <= 3 + 1e-9), 'import stays at 5 kW: 2 kW house + 3 kW charging');
  });
});

describe('measured savings', () => {
  it('compares the actual cost with no battery', () => {
    const savings = new SavingsTracker(TZ);
    const time = new Date('2026-10-05T18:00:00+02:00');
    // Evening: house 3 kW, no solar, battery covers 2.5 kW → 0.5 kW import at 4 per kWh for an hour.
    savings.add({ time, hours: 1, gridW: 500, loadW: 3000, pvW: 0, buy: 4, sell: 1 });
    // Night: charging 4 kW + house 1 kW at 1 per kWh.
    savings.add({ time: new Date('2026-10-05T03:00:00+02:00'), hours: 1, gridW: 5000, loadW: 1000, pvW: 0, buy: 1, sell: 0.5 });
    // Without battery: 3 × 4 + 1 × 1 = 13. Actual: 0.5 × 4 + 5 × 1 = 7.
    assert.ok(Math.abs(savings.savedOn('2026-10-05') - 6) < 1e-9);
    savings.setPowerFeeSaving('2026-10', 40);
    assert.ok(Math.abs(savings.savedInMonth('2026-10') - 46) < 1e-9);
  });
});

describe('savings with stored energy', () => {
  it('counts solar stored at noon at what it will save later, not as a loss', () => {
    const savings = new SavingsTracker(TZ);
    // Noon: 4 kW solar, 1 kW house, the battery takes 3 kW instead of it being sold at 1 per kWh.
    savings.add({ time: new Date('2026-09-25T12:00:00+02:00'), hours: 1, gridW: 0, loadW: 1000, pvW: 4000, buy: 2, sell: 1, batteryKwh: 10, storedValue: 2.5 });
    savings.add({ time: new Date('2026-09-25T13:00:00+02:00'), hours: 1, gridW: 0, loadW: 1000, pvW: 4000, buy: 2, sell: 1, batteryKwh: 13, storedValue: 2.5 });
    // Energy alone: −3 (the unsold solar in the second hour). Stored: +3 kWh × 2.5 = +7.5.
    assert.ok(Math.abs(savings.savedOn('2026-09-25') - (-6 + 7.5)) < 1e-9);
    // Evening: the battery covers 3 kW at 4 per kWh and is back where the day started.
    savings.add({ time: new Date('2026-09-25T19:00:00+02:00'), hours: 1, gridW: 0, loadW: 3000, pvW: 0, buy: 4, sell: 1, batteryKwh: 10, storedValue: 1 });
    assert.ok(Math.abs(savings.savedOn('2026-09-25') - (-6 + 12)) < 1e-9, 'no stored term once the energy is used');
  });
});

describe('plan monitor', () => {
  const expectation = { action: 'charge' as const, targetSoc: 90, reserveSoc: 25, maxSoc: 100 };
  const sample = (minute: number, batteryW: number, socPct = 50, gridW = 3000) => ({
    time: new Date(Date.UTC(2026, 9, 5, 2, minute)), socPct, batteryW, gridW,
  });

  it('names what does not match the plan', () => {
    assert.equal(deviationOf(sample(0, 0), expectation), 'not_charging');
    assert.equal(deviationOf(sample(0, 0, 89), expectation), null, 'at the target');
    assert.equal(deviationOf(sample(0, -800), { ...expectation, action: 'hold' }), 'discharging_while_saving');
    assert.equal(deviationOf(sample(0, 0, 60, 2000), { ...expectation, action: 'self_use' }), 'not_covering_house');
    assert.equal(deviationOf(sample(0, 3000, 60, 4000), { ...expectation, action: 'self_use' }), 'unplanned_grid_charging');
    assert.equal(deviationOf(sample(0, -2000, 60, 100), { ...expectation, action: 'self_use' }), null);
  });

  it('reports only lasting deviations and missing data', () => {
    const monitor = new PlanMonitor(20, 20);
    const now = (m: number) => new Date(Date.UTC(2026, 9, 5, 2, m));
    assert.equal(monitor.update(now(0), sample(0, 0), expectation), false);
    monitor.update(now(10), sample(10, 0), expectation);
    assert.equal(monitor.deviation, null, 'not yet 20 minutes');
    assert.equal(monitor.update(now(20), sample(20, 0), expectation), true);
    assert.equal(monitor.deviation, 'not_charging');
    monitor.update(now(25), sample(25, 4000), expectation);
    monitor.update(now(35), sample(35, 4000), expectation);
    assert.equal(monitor.deviation, null, 'charging again for 10 minutes');
    monitor.update(now(70), sample(35, 4000), expectation);
    assert.equal(monitor.deviation, 'no_data');
  });
});
