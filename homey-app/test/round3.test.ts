import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BatteryController, type ControllerConfig, type PlanState } from '../lib/controller/BatteryController.js';
import { exportSettingIssue, ThrottleDetector } from '../lib/inverter/ExportCheck.js';
import { DISABLED_SLOT, type InverterSettings, type InverterTransport } from '../lib/inverter/types.js';
import { applianceCost, bestWindow, isBestTimeNow, nextTime } from '../lib/planner/bestTime.js';
import type { PlannedInterval } from '../lib/planner/planner.js';
import { suggestPriceArea } from '../lib/prices/areas.js';
import { DEFAULT_TARIFF, isHighLoadTime, tariffHolidays, VATTENFALL_HIGH_LOAD } from '../lib/tariff.js';
import { TZ } from './helpers.js';

describe('high-load time', () => {
  it('follows Vattenfall: Nov–Mar weekdays 06–22, not on public holidays', () => {
    assert.equal(isHighLoadTime(new Date('2026-11-16T08:00:00+01:00'), TZ), true, 'Monday morning in November');
    assert.equal(isHighLoadTime(new Date('2026-11-16T22:00:00+01:00'), TZ), false, '22:00 is other time');
    assert.equal(isHighLoadTime(new Date('2026-11-15T08:00:00+01:00'), TZ), false, 'Sunday');
    assert.equal(isHighLoadTime(new Date('2026-10-15T08:00:00+02:00'), TZ), false, 'October');
    assert.equal(isHighLoadTime(new Date('2026-12-24T08:00:00+01:00'), TZ), false, 'Christmas Eve, a Thursday');
    assert.equal(isHighLoadTime(new Date('2027-03-26T08:00:00+01:00'), TZ), false, 'Good Friday 2027');
    assert.equal(isHighLoadTime(new Date('2026-11-16T08:00:00+01:00'), TZ, { ...VATTENFALL_HIGH_LOAD, fromHour: 9 }), false);
  });

  it('computes the moving holidays', () => {
    const h = tariffHolidays(2026); // Easter Sunday 5 April 2026
    assert.ok(h.has('4-3') && h.has('4-6'), 'Good Friday and Easter Monday');
    assert.equal(DEFAULT_TARIFF.gridFeeHighLoadSekPerKwh, 0.612);
  });
});

describe('price area guess', () => {
  it('uses the time zone and location', () => {
    assert.deepEqual(suggestPriceArea('Europe/Stockholm', 59.8, 17.4), { area: 'SE3', source: 'elprisetjustnu' });
    assert.equal(suggestPriceArea('Europe/Stockholm', 55.6, 13.0)?.area, 'SE4', 'Malmö');
    assert.equal(suggestPriceArea('Europe/Stockholm', 65.6, 22.1)?.area, 'SE1', 'Luleå');
    assert.equal(suggestPriceArea('Europe/Stockholm', 62.4, 17.3)?.area, 'SE2', 'Sundsvall');
    assert.equal(suggestPriceArea('Europe/Oslo', 60.4, 5.3)?.area, 'NO5', 'Bergen');
    assert.equal(suggestPriceArea('Europe/Copenhagen', 55.7, 12.6)?.area, 'DK2', 'Copenhagen');
    assert.deepEqual(suggestPriceArea('Europe/Helsinki', 60.2, 24.9), { area: 'FI', source: 'nordpool' });
    assert.equal(suggestPriceArea('America/New_York', 40, -74), null);
  });
});

describe('export control', () => {
  const settings = (exportAllowed: boolean | null, exportLimitW: number | null = 17000): InverterSettings => ({
    storageModeRaw: 51, reserveSoc: 25, overDischargeSoc: 15, offGridOverDischargeSoc: 15, forceChargeSoc: 10, maxChargeSoc: 100,
    maxChargeCurrentA: 50, maxDischargeCurrentA: 50, touV2: true, exportAllowed, exportLimitW,
    chargeSlots: Array.from({ length: 6 }, () => ({ ...DISABLED_SLOT })), dischargeSlots: Array.from({ length: 6 }, () => ({ ...DISABLED_SLOT })),
  });

  it('flags export switched off or capped, but not when the app did it', () => {
    assert.equal(exportSettingIssue(settings(false), false), 'export_blocked');
    assert.equal(exportSettingIssue(settings(false), true), null);
    assert.equal(exportSettingIssue(settings(true, 200), false), 'export_limited');
    assert.equal(exportSettingIssue(settings(true), false), null);
  });

  it('switches export off at negative prices and only undoes its own change', async () => {
    const writes: boolean[] = [];
    let allowed = true;
    const transport = {
      kind: 'soliscloud',
      readSettings: async () => settings(allowed),
      writeExportAllowed: async (value: boolean) => { writes.push(value); allowed = value; },
    } as unknown as InverterTransport;
    const controller = new BatteryController(transport, { getDay: async () => null }, {} as ControllerConfig);
    controller.exportControl = true;
    const t0 = new Date('2026-06-01T12:00:00+02:00');
    const state = { negativeExport: [{ start: t0, end: new Date(t0.getTime() + 3_600_000) }] } as PlanState;
    assert.equal(await controller.applyExport(new Date(t0.getTime() + 60_000), state), 'export off (negative export price)');
    assert.equal(await controller.applyExport(new Date(t0.getTime() + 120_000), state), null, 'no repeated writes');
    assert.equal(await controller.applyExport(new Date(t0.getTime() + 3_700_000), state), 'export on again');
    assert.deepEqual(writes, [false, true]);

    allowed = false; // switched off by the user
    assert.equal(await controller.applyExport(new Date(t0.getTime() + 60_000), state), null);
    assert.equal(await controller.applyExport(new Date(t0.getTime() + 3_700_000), state), null, 'the user\'s choice stays');
    assert.deepEqual(writes, [false, true]);
  });

  it('detects throttled solar only when it lasts', () => {
    const d = new ThrottleDetector(30, 60);
    const t = (m: number) => new Date(Date.UTC(2026, 8, 24, 9, m));
    d.update(t(0), true, 5, 2.8);
    assert.equal(d.throttled, false);
    d.update(t(30), true, 5, 2.8);
    assert.equal(d.throttled, true);
    d.update(t(35), false, 5, 2.8);
    assert.equal(d.throttled, true, 'a passing cloud does not clear it');
    d.update(t(95), false, 5, 2.8);
    assert.equal(d.throttled, false);
  });
});

describe('best time to run', () => {
  const quarters = (start: string, spec: Array<[number, number, number?]>): PlannedInterval[] => {
    const t0 = new Date(start).getTime();
    return spec.map(([buy, gridKw, stored = 0], i) => ({
      start: new Date(t0 + i * 900_000), end: new Date(t0 + (i + 1) * 900_000), buy, sell: 0.4, action: 'self_use',
      socStartPct: 50, socEndPct: 50, gridKwh: gridKw / 4, batteryKwh: 0, chargeKw: 0, storedEnergyValue: stored,
    }));
  };

  it('prices solar surplus at the export price', () => {
    const [iv] = quarters('2026-09-25T12:00:00+02:00', [[2, -3]]);
    assert.equal(applianceCost(iv, 2), 0.4, 'fully covered by 3 kW export');
    assert.ok(Math.abs(applianceCost(iv, 4) - (3 * 0.4 + 1 * 2) / 4) < 1e-9, 'partly');
  });

  it('finds the cheapest continuous window before the deadline', () => {
    const plan = quarters('2026-09-25T00:00:00+02:00', [
      [3, 1], [3, 1], [1, 1], [1, 1], [1, 1], [1, 1], [3, 1], [3, 1],
    ]);
    const now = new Date('2026-09-25T00:05:00+02:00');
    const best = bestWindow(plan, now, 60, 2, '02:00', TZ)!;
    assert.equal(best.start.toISOString(), '2026-09-24T22:30:00.000Z', '00:30–01:30');
    assert.equal(best.costPerKwh, 1);
    assert.equal(isBestTimeNow(best, now), false);
    assert.equal(isBestTimeNow(best, new Date('2026-09-25T00:31:00+02:00')), true);
    // 00:45 is too close for a one-hour run, so the deadline becomes 00:45 tomorrow: tonight's window still fits.
    assert.equal(bestWindow(plan, now, 60, 2, '00:45', TZ)?.start.toISOString(), '2026-09-24T22:30:00.000Z');
    assert.equal(bestWindow(plan, now, 180, 2, '02:00', TZ), null, 'longer than the known prices');
  });

  it('finds the next occurrence of a time', () => {
    assert.equal(nextTime('07:00', new Date('2026-09-25T22:00:00+02:00'), TZ).toISOString(), '2026-09-26T05:00:00.000Z');
    assert.equal(nextTime('23:00', new Date('2026-09-25T22:00:00+02:00'), TZ).toISOString(), '2026-09-25T21:00:00.000Z');
  });
});

