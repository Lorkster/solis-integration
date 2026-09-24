import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LoadProfile } from '../lib/forecast/LoadProfile.js';
import { parseHistorySample } from '../lib/solis/SolisCloudTransport.js';
import { TZ } from './helpers.js';

const at = (iso: string) => new Date(iso);

describe('LoadProfile', () => {
  it('averages samples per quarter and predicts after enough observations', () => {
    const profile = new LoadProfile(TZ);
    // Three weekdays (Mon–Wed), 18:00–18:15 local, samples 2 and 4 kW → quarter mean 3 kW.
    for (const day of ['2026-09-21', '2026-09-22', '2026-09-23']) {
      profile.addSample(at(`${day}T18:02:00+02:00`), 2);
      profile.addSample(at(`${day}T18:10:00+02:00`), 4);
    }
    profile.flush();
    assert.equal(profile.predict(at('2026-09-24T18:05:00+02:00')), 3);
    assert.equal(profile.predict(at('2026-09-24T19:05:00+02:00')), null, 'unobserved slot');
  });

  it('learns weekends separately and falls back to weekdays', () => {
    const profile = new LoadProfile(TZ);
    for (const day of ['2026-09-21', '2026-09-22', '2026-09-23']) profile.addSample(at(`${day}T08:00:00+02:00`), 1);
    for (const day of ['2026-09-19', '2026-09-20', '2026-09-26']) profile.addSample(at(`${day}T08:00:00+02:00`), 5);
    profile.addSample(at('2026-09-26T09:00:00+02:00'), 0); // commits the last quarter
    assert.equal(profile.predict(at('2026-09-24T08:00:00+02:00')), 1);
    assert.equal(profile.predict(at('2026-09-27T08:00:00+02:00')), 5);

    const weekdaysOnly = new LoadProfile(TZ, profile.toJSON());
    assert.equal(weekdaysOnly.predict(at('2026-09-27T08:00:00+02:00')), 5, 'restored from stored data');
  });

  it('adapts to change with an exponential moving average', () => {
    const profile = new LoadProfile(TZ);
    // Twelve Mondays 18:00 CET (all before the DST change): six at 2 kW, then six at 6 kW.
    const days = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 0, 5 + i * 7, 17, 0)));
    days.slice(0, 6).forEach((d) => profile.addSample(d, 2));
    days.slice(6).forEach((d) => profile.addSample(d, 6));
    profile.flush();
    const predicted = profile.predict(days[11])!;
    // 6 - 4 * 0.8^6 ≈ 4.95: follows the new level without jumping to it.
    assert.ok(Math.abs(predicted - (6 - 4 * 0.8 ** 6)) < 1e-9, `predicted ${predicted}`);
  });
});

describe('parseHistorySample', () => {
  it('reads W-based history records', () => {
    const sample = parseHistorySample({ dataTimestamp: '1790073746672', familyLoadPower: 3035.0, pSum: 715, batteryPower: 0 });
    assert.equal(sample?.loadW, 3035);
    assert.equal(sample?.gridW, -715, 'exporting');
    assert.equal(sample?.time.getTime(), 1790073746672);
  });
});
