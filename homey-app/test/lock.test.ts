import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LockDetector, type LockSample } from '../lib/inverter/LockDetector.js';

const at = (hhmm: string) => new Date(`2026-09-24T${hhmm}:00+02:00`);
// Shaped like 24 Sep: 0 A limit left by the EMS, full battery idle, house importing.
const locked = (hhmm: string, extra: Partial<LockSample> = {}): LockSample => ({
  time: at(hhmm), remoteEnabled: true, remoteCurrentA: 0, socPct: 98, gridW: 2000, batteryW: 0, ...extra,
});

describe('LockDetector', () => {
  it('reports a lock that persists and costs grid import, and its release', () => {
    const d = new LockDetector();
    assert.equal(d.update(locked('00:10'), 40), false);
    assert.equal(d.locked, false, 'not yet: needs 30 minutes');
    assert.equal(d.update(locked('00:40'), 40), true);
    assert.equal(d.locked, true);
    // Quick Control ended at 16:14 and the limit returned to 50 A.
    assert.equal(d.update(locked('16:17', { remoteCurrentA: 50, batteryW: -1644, socPct: 93, gridW: 0 }), 40), true);
    assert.equal(d.locked, false);
  });

  it('does not alarm when the 0 A limit costs nothing', () => {
    const d = new LockDetector();
    d.update(locked('10:00', { gridW: 0 }), 40); // solar covers the house
    d.update(locked('11:00', { gridW: 0 }), 40);
    assert.equal(d.locked, false);
    d.update(locked('12:00', { socPct: 41, gridW: 2000 }), 40); // battery at the reserve anyway
    d.update(locked('13:00', { socPct: 41, gridW: 2000 }), 40);
    assert.equal(d.locked, false);
  });

  it('does not mistake a planned save period for a lock', () => {
    const d = new LockDetector();
    // 24 Sep 18:42: planned save, the active 0 A slot shows as a 0 A limit.
    d.update(locked('18:42', { gridW: 3818, socPct: 61 }), 25, true);
    d.update(locked('19:15', { gridW: 3500, socPct: 61 }), 25, true);
    assert.equal(d.locked, false);
  });

  it('ignores inverters that do not report the remote limit', () => {
    const d = new LockDetector();
    d.update(locked('10:00', { remoteEnabled: null, remoteCurrentA: null }), 40);
    d.update(locked('11:00', { remoteEnabled: null, remoteCurrentA: null }), 40);
    assert.equal(d.locked, false);
  });
});
