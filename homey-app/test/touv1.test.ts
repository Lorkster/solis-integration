import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SolisCloudClient } from '../lib/solis/SolisCloudClient.js';
import { SolisCloudTransport } from '../lib/solis/SolisCloudTransport.js';
import { formatTouV1, parseTouV1, setTouV1Slot, touV1Slots } from '../lib/solis/touV1.js';

// The two layouts, as in github.com/mkuthan/solis-cloud-control's tests.
const V18 = '0,0,09:00,10:00,11:00,12:00,50,0,12:30,13:30,14:30,15:30,0,100,16:00,17:00,18:00,19:00';
const V12 = '0,0,09:00-10:00,11:00-12:00,50,0,12:30-13:30,14:30-15:30,0,100,16:00-17:00,18:00-19:00';

describe('3-slot schedule (CID 103)', () => {
  it('reads both layouts the same way', () => {
    for (const text of [V18, V12]) {
      const { charge, discharge } = touV1Slots(parseTouV1(text)!);
      assert.deepEqual(charge[1], { enabled: true, start: '12:30', end: '13:30', currentA: 50, soc: 100 });
      assert.deepEqual(discharge[2], { enabled: true, start: '18:00', end: '19:00', currentA: 100, soc: 100 });
      assert.equal(charge.length, 3);
    }
    assert.equal(parseTouV1('1,2,3'), null);
  });

  it('writes one slot and keeps the layout and the other slots', () => {
    const t18 = parseTouV1(V18)!;
    setTouV1Slot(t18, 'charge', 0, { enabled: true, start: '02:00', end: '04:30', currentA: 16, soc: 84 });
    setTouV1Slot(t18, 'discharge', 2, { enabled: false, start: '18:00', end: '19:00', currentA: 100, soc: 100 });
    assert.equal(formatTouV1(t18), '16,0,02:00,04:30,11:00,12:00,50,0,12:30,13:30,14:30,15:30,0,0,16:00,17:00,00:00,00:00');
    const t12 = parseTouV1(V12)!;
    setTouV1Slot(t12, 'charge', 0, { enabled: true, start: '02:00', end: '04:30', currentA: 16, soc: 84 });
    assert.equal(formatTouV1(t12).split(',').slice(0, 4).join(','), '16,0,02:00-04:30,11:00-12:00');
    assert.throws(() => setTouV1Slot(t12, 'charge', 3, { enabled: true, start: '01:00', end: '02:00', currentA: 5, soc: 50 }), /no slot 4/);
    setTouV1Slot(t12, 'charge', 5, { enabled: false, start: '00:00', end: '00:00', currentA: 0, soc: 100 }); // ignored
  });

  it('is read and written through SolisCloud on older firmware', async () => {
    class OldFirmware extends SolisCloudClient {
      schedule = V18;
      writes: Array<[number, string]> = [];
      constructor() { super({ keyId: 'k', keySecret: 's' }); }
      override async read(_sn: string, cid: number): Promise<string> { return cid === 103 ? this.schedule : '0'; }
      override async readBatch(_sn: string, cids: number[]): Promise<Map<number, string>> {
        assert.ok(!cids.includes(5916), 'no 6+6 slot CIDs on older firmware');
        return new Map(cids.map((c) => [c, c === 103 ? this.schedule : '10']));
      }
      override async control(_sn: string, cid: number, value: string): Promise<void> {
        this.writes.push([cid, value]);
        if (cid === 103) this.schedule = value;
      }
    }
    const cloud = new OldFirmware();
    const transport = new SolisCloudTransport({ keyId: 'k', keySecret: 's' }, 'SN', cloud);
    const settings = await transport.readSettings();
    assert.equal(settings.touV2, false);
    assert.equal(settings.chargeSlots.length, 3);
    await transport.writeChargeSlot(2, { enabled: true, start: '13:45', end: '15:30', currentA: 16, soc: 100 });
    assert.deepEqual(cloud.writes, [[103, '0,0,09:00,10:00,11:00,12:00,50,0,12:30,13:30,14:30,15:30,16,100,13:45,15:30,18:00,19:00']]);
  });
});
