import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addDays, localDate, localDateOffset, localHHMM } from '../lib/time.js';
import { TZ } from './helpers.js';

describe('local dates around daylight-saving changes', () => {
  it('finds tomorrow on the evening before summer time starts (23-hour day)', () => {
    const evening = new Date('2027-03-27T23:30:00+01:00'); // the clocks go forward on 28 Mar at 02:00
    assert.equal(localDateOffset(evening, 1, TZ), '2027-03-28');
    assert.equal(localDate(addDays(evening, 1), TZ), '2027-03-29', '24 hours later skips a day');
  });

  it('finds tomorrow in the night before winter time starts (25-hour day)', () => {
    const night = new Date('2026-10-25T00:30:00+02:00'); // the clocks go back at 03:00
    assert.equal(localDateOffset(night, 1, TZ), '2026-10-26');
    assert.equal(localDate(addDays(night, 1), TZ), '2026-10-25', '24 hours later is the same day');
  });

  it('counts back over a change and across a month end', () => {
    assert.equal(localDateOffset(new Date('2026-10-26T00:30:00+01:00'), -1, TZ), '2026-10-25');
    assert.equal(localDateOffset(new Date('2026-11-01T12:00:00+01:00'), -1, TZ), '2026-10-31');
    assert.equal(localDateOffset(new Date('2026-12-31T23:30:00+01:00'), 1, TZ), '2027-01-01');
  });

  it('shows clock times in winter time after the change', () => {
    assert.equal(localHHMM(new Date('2026-10-25T00:30:00Z'), TZ), '02:30', 'summer time, before the change');
    assert.equal(localHHMM(new Date('2026-10-25T01:30:00Z'), TZ), '02:30', 'winter time, the repeated hour');
    assert.equal(localHHMM(new Date('2026-10-28T23:00:00Z'), TZ), '00:00');
  });
});
