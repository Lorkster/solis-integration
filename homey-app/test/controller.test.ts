import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BatteryController, type ControllerConfig } from '../lib/controller/BatteryController.js';
import { DISABLED_SLOT, type InverterSettings, type InverterTransport, type LiveData, type TouSlot } from '../lib/inverter/types.js';
import type { PriceProvider, SpotPrice } from '../lib/prices/PriceProvider.js';
import { DEFAULT_TARIFF } from '../lib/tariff.js';
import { quarters, TZ } from './helpers.js';

class FakeInverter implements InverterTransport {
  readonly kind = 'soliscloud' as const;
  writes: string[] = [];
  settings: InverterSettings = {
    storageModeRaw: 33,
    reserveSoc: 25,
    overDischargeSoc: 15,
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

class FakePrices implements PriceProvider {
  async getDay(date: string): Promise<SpotPrice[] | null> {
    if (date !== '2026-09-24') return null;
    const spot = quarters([
      1.0, 1.0, 1.0, 1.0, 1.0, 1.1, 1.4, 2.2, 2.3, 1.9, 1.3, 1.1,
      1.0, 0.9, 0.9, 0.9, 1.1, 1.5, 2.0, 2.2, 2.1, 1.5, 1.0, 0.8,
    ]);
    const t0 = new Date('2026-09-24T00:00:00+02:00').getTime();
    return spot.map((sekPerKwh, i) => ({ start: new Date(t0 + i * 900_000), end: new Date(t0 + (i + 1) * 900_000), sekPerKwh }));
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
    const controller = new BatteryController(inverter, new FakePrices(), config);
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
    const controller = new BatteryController(inverter, new FakePrices(), config);
    await controller.apply(await controller.buildPlan(live, new Date('2026-09-24T00:05:00+02:00')));
    await controller.restoreInverter();
    assert.ok(inverter.settings.chargeSlots.every((s) => !s.enabled));
    assert.equal(inverter.settings.storageModeRaw, 49, 'TOU off, backup + grid charge kept');
  });

  it('uses the PV forecast scaled by trust', async () => {
    const controller = new BatteryController(new FakeInverter(), new FakePrices(), config);
    controller.pvForecast = () => 5;
    const state = await controller.buildPlan({ ...live, socPct: 50 }, new Date('2026-09-24T00:05:00+02:00'));
    // 5 kW × 80 % trust = 4 kW PV against a 2 kW load: the surplus charges the battery.
    const first = state.plan.intervals[0];
    assert.ok(first.batteryKwh > 0.4 && first.gridKwh <= 0, `battery ${first.batteryKwh} kWh, grid ${first.gridKwh} kWh`);
  });

  it('raises the reserve while preparing for an outage', async () => {
    const controller = new BatteryController(new FakeInverter(), new FakePrices(), config);
    const now = new Date('2026-09-24T00:05:00+02:00');
    controller.outage = { targetSoc: 100, until: new Date('2026-09-24T12:00:00+02:00') };
    const state = await controller.buildPlan(live, now);
    assert.equal(state.reserveSoc, 100);
    assert.equal(state.plan.intervals[0].action, 'charge');
  });
});
