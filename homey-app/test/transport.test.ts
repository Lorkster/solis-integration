import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DISABLED_SLOT } from '../lib/inverter/types.js';
import { SolisCloudClient } from '../lib/solis/SolisCloudClient.js';
import { SolisCloudTransport } from '../lib/solis/SolisCloudTransport.js';

/** In-memory inverter behind a fake SolisCloud: switch CIDs share one bit-field register. */
class FakeCloud extends SolisCloudClient {
  register = 0;
  values = new Map<number, string>();
  controls: Array<{ cid: number; value: string; previous?: string }> = [];
  private static readonly SWITCHES = [5916, 5917, 5918, 5919, 5920, 5921, 5922, 5923, 5924, 5925, 5926, 5927];

  constructor() {
    super({ keyId: 'k', keySecret: 's' });
  }

  override async readBatch(_sn: string, cids: number[]): Promise<Map<number, string>> {
    return new Map(cids.map((cid) => {
      const bit = FakeCloud.SWITCHES.indexOf(cid);
      return [cid, bit >= 0 ? String((this.register >> bit) & 1) : this.values.get(cid) ?? '0'];
    }));
  }

  override async control(_sn: string, cid: number, value: string, previous?: string): Promise<void> {
    this.controls.push({ cid, value, previous });
    const bit = FakeCloud.SWITCHES.indexOf(cid);
    if (bit >= 0) {
      // What SolisCloud does: apply the bit to the old value it was given.
      const base = Number(previous ?? 0);
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
});
