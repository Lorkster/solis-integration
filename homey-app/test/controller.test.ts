import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { solisWorkMode } from '../lib/brands/solis/storageMode.js';
import { alignSlots, BatteryController, type ControllerConfig, overlaps, type PlanState } from '../lib/controller/BatteryController.js';
import { DISABLED_SLOT, type InverterSettings, type InverterTransport, type LiveData, type TouSlot } from '../lib/inverter/types.js';
import type { PriceProvider, SpotPrice } from '../lib/prices/PriceProvider.js';
import { DEFAULT_TARIFF } from '../lib/tariff.js';
import { quarters, TZ } from './helpers.js';

class FakeInverter implements InverterTransport {
  readonly kind = 'cloud' as const;
  readonly name = 'SolisCloud';
  writes: string[] = [];
  settings: InverterSettings = {
    storageModeRaw: 33,
    reserveSoc: 25,
    overDischargeSoc: 15,
    offGridOverDischargeSoc: 30,
    forceChargeSoc: 10,
    maxChargeSoc: 100,
    maxChargeCurrentA: 16,
    maxDischargeCurrentA: 25,
    touV2: true,
    chargeSlots: Array.from({ length: 6 }, () => ({ ...DISABLED_SLOT })),
    dischargeSlots: Array.from({ length: 6 }, () => ({ ...DISABLED_SLOT, soc: 50 })),
  };

  async getLiveData(): Promise<LiveData> { throw new Error('not used'); }
  async readSettings(): Promise<InverterSettings> { return structuredClone(this.settings); }
  async writeStorageMode(raw: number): Promise<void> { this.writes.push(`mode ${raw}`); this.settings.storageModeRaw = raw; }
  async writeReserveSoc(pct: number): Promise<void> { this.writes.push(`reserve ${pct}`); this.settings.reserveSoc = pct; }
  async writeChargeSlot(i: number, slot: TouSlot): Promise<void> { this.writes.push(`charge ${i}`); this.settings.chargeSlots[i] = { ...slot }; }
  async writeDischargeSlot(i: number, slot: TouSlot): Promise<void> { this.writes.push(`discharge ${i}`); this.settings.dischargeSlots[i] = { ...slot }; }
}

/** The controller as the Solis device sets it up: Solis storage mode bits. */
function solisController(inverter: InverterTransport): BatteryController {
  const controller = new BatteryController(inverter, new FakePrices(), config);
  controller.workMode = solisWorkMode;
  return controller;
}

class FakePrices implements PriceProvider {
  async getDay(date: string): Promise<SpotPrice[] | null> {
    if (date !== '2026-09-24') return null;
    const spot = quarters([
      1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.4, 2.2, 2.3, 1.9, 1.3, 1.1,
      1.0, 0.9, 0.9, 0.9, 1.1, 1.5, 2.0, 2.2, 2.1, 1.5, 1.0, 0.8,
    ]);
    const t0 = new Date('2026-09-24T00:00:00+02:00').getTime();
    return spot.map((perKwh, i) => ({ start: new Date(t0 + i * 900_000), end: new Date(t0 + (i + 1) * 900_000), perKwh }));
  }
}

const config: ControllerConfig = {
  timeZone: TZ,
  priceArea: 'SE3',
  tariff: DEFAULT_TARIFF,
  capacityKwh: 21.68,
  maxChargeKw: 6.5,
  maxDischargeKw: 10,
  roundTripEfficiency: 0.9,
  cyclingCostPerKwh: 0.2,
  minGainPerKwh: 0.1,
  reserveSocSummer: 25,
  reserveSocWinter: 30,
  maxSocPct: 100,
  avgLoadKw: 2,
  pvTrust: 0.8,
};

const live = { socPct: 20, batteryVoltageV: 420 } as LiveData;

describe('BatteryController', () => {
  it('writes slots before the storage mode and nothing on a second run', async () => {
    const inverter = new FakeInverter();
    const controller = solisController(inverter);
    const now = new Date('2026-09-24T00:05:00+02:00');

    const state = await controller.buildPlan(live, now);
    assert.ok(state.schedule.chargeSlots.some((s) => s.enabled && s.currentA > 0), 'plans grid charging');

    const changes = await controller.apply(state);
    assert.ok(changes.length > 0);
    assert.equal(inverter.writes[inverter.writes.length - 1], 'mode 51', 'storage mode written last');
    assert.ok(!inverter.writes.some((w) => w.startsWith('discharge')), 'disabled discharge slots left alone');

    inverter.writes = [];
    assert.deepEqual(await controller.apply(state), []);
    assert.deepEqual(inverter.writes, []);
  });

  it('hands control back to the inverter', async () => {
    const inverter = new FakeInverter();
    const controller = solisController(inverter);
    await controller.apply(await controller.buildPlan(live, new Date('2026-09-24T00:05:00+02:00')));
    await controller.restoreInverter();
    assert.ok(inverter.settings.chargeSlots.every((s) => !s.enabled));
    assert.equal(inverter.settings.storageModeRaw, 49, 'TOU off, backup + grid charge kept');
  });

  const slot = (start: string, end: string, currentA: number, soc: number, enabled = true): TouSlot => ({ enabled, start, end, currentA, soc });
  const planWith = (...slots: TouSlot[]) => ({
    reserveSoc: 25,
    schedule: { chargeSlots: [...slots, ...Array.from({ length: 6 - slots.length }, () => ({ ...DISABLED_SLOT }))], warnings: [] },
  }) as unknown as PlanState;

  it('keeps a planned slot that is already running where it is (26 Sep 11:06)', async () => {
    const inverter = new FakeInverter();
    inverter.settings.chargeSlots[0] = slot('12:15', '17:15', 16, 100, false);
    inverter.settings.chargeSlots[1] = slot('03:00', '07:45', 0, 52);
    inverter.settings.chargeSlots[2] = slot('12:15', '17:15', 16, 100);
    const controller = new BatteryController(inverter, new FakePrices(), config);
    await controller.apply(planWith(slot('12:15', '17:15', 16, 100)));
    assert.deepEqual(inverter.writes, ['charge 1'], 'only the old hold switched off');
    assert.equal(inverter.settings.chargeSlots[1].enabled, false);
    assert.equal(inverter.settings.chargeSlots[2].enabled, true);
  });

  it('switches changed slots off before switching new ones on, so none overlap (26 Sep 01:57)', async () => {
    const inverter = new FakeInverter();
    inverter.settings.chargeSlots[0] = slot('01:45', '02:00', 16, 33);
    inverter.settings.chargeSlots[1] = slot('02:00', '12:15', 0, 32);
    const order: string[] = [];
    const write = inverter.writeChargeSlot.bind(inverter);
    inverter.writeChargeSlot = async (i, s) => {
      order.push(`${i + 1} ${s.enabled ? `on ${s.start}-${s.end}` : 'off'}`);
      return write(i, s);
    };
    const controller = new BatteryController(inverter, new FakePrices(), config);
    await controller.apply(planWith(slot('01:45', '02:30', 16, 47), slot('02:30', '08:00', 0, 46)));
    assert.deepEqual(order, ['1 off', '2 off', '3 on 01:45-02:30', '4 on 02:30-08:00'], 'new slots in unused positions');
  });

  it('does not switch on a slot over one that could not be switched off, and reports it', async () => {
    const inverter = new FakeInverter();
    inverter.settings.chargeSlots[0] = slot('02:00', '12:15', 0, 32);
    const write = inverter.writeChargeSlot.bind(inverter);
    inverter.writeChargeSlot = async (i, s) => {
      if (i === 0 && !s.enabled) throw new Error('Slot switch CID 5916 did not change to 0');
      return write(i, s);
    };
    const controller = new BatteryController(inverter, new FakePrices(), config);
    await assert.rejects(controller.apply(planWith(slot('01:45', '02:30', 16, 47), slot('02:30', '08:00', 0, 46))), /overlaps 02:00-12:15/);
    assert.equal(inverter.settings.chargeSlots[0].start, '02:00', 'the old slot is left as it was');
  });

  it('finds overlapping daily slots, also past midnight', () => {
    assert.equal(overlaps(slot('12:15', '17:15', 16, 100), slot('12:15', '17:15', 16, 100)), true);
    assert.equal(overlaps(slot('01:45', '02:30', 16, 47), slot('02:30', '08:00', 0, 46)), false, 'touching is fine');
    assert.equal(overlaps(slot('22:00', '02:00', 16, 80), slot('01:00', '03:00', 0, 80)), true);
    assert.deepEqual(alignSlots([slot('03:00', '07:45', 0, 52), slot('12:15', '17:15', 16, 100)],
      [slot('12:15', '17:15', 16, 100), { ...DISABLED_SLOT }]).map((s) => s.enabled), [false, true]);
  });

  it('leaves the work mode alone for a brand without one', async () => {
    const inverter = new FakeInverter();
    const controller = new BatteryController(inverter, new FakePrices(), config);
    await controller.apply(await controller.buildPlan(live, new Date('2026-09-24T00:05:00+02:00')));
    await controller.restoreInverter();
    assert.equal(inverter.settings.storageModeRaw, 33);
    assert.ok(!inverter.writes.some((w) => w.startsWith('mode')));
  });

  it('uses the PV forecast scaled by trust', async () => {
    const controller = solisController(new FakeInverter());
    controller.pvForecast = () => 5;
    const state = await controller.buildPlan({ ...live, socPct: 50 }, new Date('2026-09-24T00:05:00+02:00'));
    // 5 kW × 80 % trust = 4 kW PV against a 2 kW load: the surplus charges the battery.
    const first = state.plan.intervals[0];
    assert.ok(first.batteryKwh > 0.4 && first.gridKwh <= 0, `battery ${first.batteryKwh} kWh, grid ${first.gridKwh} kWh`);
  });

  it('raises the reserve while preparing for an outage', async () => {
    const controller = solisController(new FakeInverter());
    const now = new Date('2026-09-24T00:05:00+02:00');
    controller.outage = { targetSoc: 100, until: new Date('2026-09-24T12:00:00+02:00') };
    const state = await controller.buildPlan(live, now);
    assert.equal(state.reserveSoc, 100);
    assert.equal(state.plan.intervals[0].action, 'charge');
  });
});
