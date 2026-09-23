import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { controlledStorageMode, hasFlag } from '../lib/inverter/storageMode.js';
import { contentMd5, signRequest, SolisApiError, SolisCloudClient } from '../lib/solis/SolisCloudClient.js';
import { parseLiveData } from '../lib/solis/SolisCloudTransport.js';
import { buyPrice, DEFAULT_TARIFF, isHighLoadTime } from '../lib/tariff.js';
import { TZ } from './helpers.js';

describe('SolisCloud signing', () => {
  it('matches the reference Python implementation', () => {
    const body = '{"inverterSn":"123","cid":636}';
    assert.equal(contentMd5(body), 'vBQhbHL3Ha4RrHUQiGYtNg==');
    assert.equal(signRequest('secret', body, 'Thu, 24 Sep 2026 00:00:00 GMT', '/v2/api/atRead'), 'ph0ACpHt4Bxweekp+CzpkmVuDdo=');
  });

  it('retries transient errors and surfaces permanent ones', async () => {
    let calls = 0;
    const client = new SolisCloudClient({ keyId: 'id', keySecret: 's' }, {
      minSpacingMs: 0,
      requester: async () => {
        calls++;
        const body = calls === 1
          ? { code: 'B0115', msg: 'datalogger offline' }
          : { code: '0', data: { msg: '33' } };
        return { status: 200, body: JSON.stringify(body) };
      },
    });
    assert.equal(await client.read('sn', 636), '33');
    assert.equal(calls, 2);

    const denied = new SolisCloudClient({ keyId: 'id', keySecret: 's' }, {
      minSpacingMs: 0,
      requester: async () => ({ status: 200, body: JSON.stringify({ code: 'B0610', msg: 'Access denied' }) }),
    });
    await assert.rejects(denied.read('sn', 52), (err: unknown) => err instanceof SolisApiError && err.code === 'B0610');
  });
});

describe('parseLiveData', () => {
  it('parses a charging snapshot with unit conversion', () => {
    const live = parseLiveData({
      dataTimestamp: '1790179819401',
      batteryCapacitySoc: 16,
      batteryPower: 6.704, batteryPowerStr: 'kW', batteryDirection: 1,
      batteryPowerZheng: 6704, batteryPowerFu: 0,
      dcPac: 0, dcPacStr: 'kW',
      psum: -9.8, psumStr: 'kW',
      familyLoadPower: 2.94, familyLoadPowerStr: 'kW',
      batteryVoltage: 421.5,
      batteryTotalChargeEnergy: 5.215, batteryTotalChargeEnergyStr: 'MWh',
      batteryTotalDischargeEnergy: 4.955, batteryTotalDischargeEnergyStr: 'MWh',
    });
    assert.equal(live.batteryPowerW, 6704);
    assert.equal(live.gridPowerW, 9800);
    assert.equal(live.loadPowerW, 2940);
    assert.equal(live.batteryChargedTotalKwh, 5215);
    assert.equal(live.socPct, 16);
  });

  it('reports discharging as negative battery power', () => {
    const live = parseLiveData({ batteryPowerZheng: 0, batteryPowerFu: 2100, batteryCapacitySoc: 80 });
    assert.equal(live.batteryPowerW, -2100);
  });
});

describe('storage mode', () => {
  it('turns plain self-use + grid charge into controlled mode', () => {
    const mode = controlledStorageMode(33, true);
    assert.equal(mode, 51); // self-use, TOU, backup, grid charge
    assert.ok(hasFlag(mode, 'timeOfUse') && hasFlag(mode, 'backup') && hasFlag(mode, 'gridCharge'));
    assert.equal(controlledStorageMode(64 + 1, false), 35); // feed-in priority removed
  });
});

describe('tariff', () => {
  it('detects Vattenfall high-load time', () => {
    assert.equal(isHighLoadTime(new Date('2026-01-14T07:00:00+01:00'), TZ), true); // Wednesday morning
    assert.equal(isHighLoadTime(new Date('2026-01-14T22:30:00+01:00'), TZ), false);
    assert.equal(isHighLoadTime(new Date('2026-01-17T12:00:00+01:00'), TZ), false); // Saturday
    assert.equal(isHighLoadTime(new Date('2026-09-23T12:00:00+02:00'), TZ), false); // summer
  });

  it('adds fees before VAT', () => {
    const price = buyPrice(1.0, new Date('2026-09-23T12:00:00+02:00'), TZ, DEFAULT_TARIFF);
    assert.ok(Math.abs(price - 1.25 * (1.0 + 0.1223 + 0.36 + 0.244)) < 1e-9);
  });
});
