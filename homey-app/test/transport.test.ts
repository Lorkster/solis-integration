import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DISABLED_SLOT } from '../lib/inverter/types.js';
import { SolisCloudClient } from '../lib/brands/solis/SolisCloudClient.js';
import { parseLiveData, SolisCloudTransport } from '../lib/brands/solis/SolisCloudTransport.js';

/** In-memory inverter behind a fake SolisCloud: switch CIDs share one bit-field register. */
class FakeCloud extends SolisCloudClient {
  register = 0;
  values = new Map<number, string>();
  controls: Array<{ cid: number; value: string; previous?: string }> = [];
  private static readonly SWITCHES = [5916, 5917, 5918, 5919, 5920, 5921, 5922, 5923, 5924, 5925, 5926, 5927];

  constructor() {
    super({ keyId: 'k', keySecret: 's' });
  }

  /** Batch reads right after a switch write return the register as it was before it, this many times (SolisCloud lag). */
  lagAfterWrite = 0;
  private staleBatchReads = 0;
  private before = 0;

  override async readBatch(_sn: string, cids: number[]): Promise<Map<number, string>> {
    const register = this.staleBatchReads > 0 ? (this.staleBatchReads--, this.before) : this.register;
    return new Map(cids.map((cid) => {
      const bit = FakeCloud.SWITCHES.indexOf(cid);
      return [cid, bit >= 0 ? String((register >> bit) & 1) : this.values.get(cid) ?? '0'];
    }));
  }

  override async read(_sn: string, cid: number): Promise<string> {
    const bit = FakeCloud.SWITCHES.indexOf(cid);
    return bit >= 0 ? String((this.register >> bit) & 1) : this.values.get(cid) ?? '0';
  }

  override async control(_sn: string, cid: number, value: string, previous?: string): Promise<void> {
    this.controls.push({ cid, value, previous });
    const bit = FakeCloud.SWITCHES.indexOf(cid);
    if (bit >= 0) {
      this.before = this.register;
      this.staleBatchReads = this.lagAfterWrite;
      // What SolisCloud does: apply the bit to the old value it was given; nothing when that already has it.
      const base = Number(previous ?? 0);
      if (((base >> bit) & 1) === Number(value)) return;
      this.register = value === '1' ? base | (1 << bit) : base & ~(1 << bit);
    } else {
      this.values.set(cid, value);
    }
  }
}

describe('SolisCloudTransport slot switches', () => {
  it('keeps other slots enabled when enabling one (24 Sep bug)', async () => {
    const cloud = new FakeCloud();
    const transport = new SolisCloudTransport({ keyId: 'k', keySecret: 's' }, 'SN', cloud);
    await transport.writeChargeSlot(0, { enabled: true, start: '13:45', end: '15:30', currentA: 16, soc: 84 }, { ...DISABLED_SLOT });
    await transport.writeChargeSlot(1, { enabled: true, start: '15:30', end: '17:30', currentA: 0, soc: 83 }, { ...DISABLED_SLOT });
    assert.equal(cloud.register, 0b11, 'both slot 1 and slot 2 enabled');
    await transport.writeChargeSlot(0, { ...DISABLED_SLOT }, { enabled: true, start: '13:45', end: '15:30', currentA: 16, soc: 84 });
    assert.equal(cloud.register, 0b10, 'disabling slot 1 leaves slot 2');
  });

  it('switches a changed slot back on although SolisCloud still reports the old switches (26 Sep bug)', async () => {
    const cloud = new FakeCloud();
    const transport = new SolisCloudTransport({ keyId: 'k', keySecret: 's' }, 'SN', cloud);
    const slot = { enabled: true, start: '01:45', end: '02:00', currentA: 16, soc: 33 };
    await transport.writeChargeSlot(0, slot, { ...DISABLED_SLOT });
    await transport.writeChargeSlot(1, { ...slot, start: '02:00', end: '12:15', currentA: 0 }, { ...DISABLED_SLOT });
    cloud.lagAfterWrite = 1;
    await transport.writeChargeSlot(0, { ...slot, end: '02:30', soc: 47 }, slot);
    assert.equal(cloud.register, 0b11, 'slot 1 on again, slot 2 untouched');
  });

  it('fails when a switch does not follow, so the plan reports it', async () => {
    const cloud = new FakeCloud();
    cloud.control = async () => undefined; // accepted but never applied
    const transport = new SolisCloudTransport({ keyId: 'k', keySecret: 's' }, 'SN', cloud);
    await assert.rejects(transport.writeChargeSlot(0, { enabled: true, start: '01:45', end: '02:00', currentA: 16, soc: 33 }, { ...DISABLED_SLOT }),
      /did not change/);
  });
});

describe('SolisCloud live data', () => {
  it('reads lifetime totals in their units (MWh on this inverter)', () => {
    const live = parseLiveData({
      dataTimestamp: '1790264410000', batteryCapacitySoc: 50, psum: -1.2, psumStr: 'kW', familyLoadPower: 2, familyLoadPowerStr: 'kW',
      eTotal: 8.556, eTotalStr: 'MWh', gridPurchasedTotalEnergy: 20.421, gridPurchasedTotalEnergyStr: 'MWh',
      gridSellTotalEnergy: 2.497, gridSellTotalEnergyStr: 'MWh', uAc1: 230, uAc2: 230, uAc3: 230,
    });
    assert.ok(Math.abs(live.pvTotalKwh - 8556) < 1e-6);
    assert.ok(Math.abs(live.gridImportTotalKwh - 20421) < 1e-6);
    assert.ok(Math.abs(live.gridExportTotalKwh - 2497) < 1e-6);
    assert.equal(live.gridPowerW, 1200, 'import positive');
  });
});
