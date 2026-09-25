import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { median, parseBlend, parseSolcast, pointsToQuarters } from '../lib/forecast/SolarForecast.js';
import { type InverterInfo, supportLevel } from '../lib/inverter/types.js';
import { currencyForArea, FlowPriceProvider, parseFlowPrices, parseNordPool, toQuarters } from '../lib/prices/PriceProvider.js';
import { SolisCloudClient } from '../lib/brands/solis/SolisCloudClient.js';
import { inspectInverter } from '../lib/brands/solis/SolisCloudTransport.js';
import { parseMetNoWarnings } from '../lib/warnings/MetNoWarnings.js';
import { TZ } from './helpers.js';

describe('price sources', () => {
  it('reads Nord Pool prices per MWh as per kWh', () => {
    const json = {
      multiAreaEntries: [
        { deliveryStart: '2026-09-24T22:00:00Z', deliveryEnd: '2026-09-24T22:15:00Z', entryPerArea: { SE3: 1354.6 } },
        { deliveryStart: '2026-09-24T22:15:00Z', deliveryEnd: '2026-09-24T22:30:00Z', entryPerArea: { SE3: 1200 } },
      ],
    };
    const prices = parseNordPool(json, 'SE3');
    assert.equal(prices.length, 2);
    assert.ok(Math.abs(prices[0].perKwh - 1.3546) < 1e-9);
    assert.deepEqual(parseNordPool(json, 'NO1'), []);
  });

  it('picks the currency from the area', () => {
    assert.equal(currencyForArea('SE3'), 'SEK');
    assert.equal(currencyForArea('NO5'), 'NOK');
    assert.equal(currencyForArea('DK1'), 'DKK');
    assert.equal(currencyForArea('PL'), 'PLN');
    assert.equal(currencyForArea('FI'), 'EUR');
  });

  it('splits hourly prices into quarters', () => {
    const q = toQuarters([{ start: new Date('2026-09-25T00:00:00Z'), end: new Date('2026-09-25T01:00:00Z'), perKwh: 0.5 }]);
    assert.equal(q.length, 4);
    assert.equal(q[3].start.toISOString(), '2026-09-25T00:45:00.000Z');
  });

  it('accepts prices from a flow in several shapes', () => {
    const hourly = parseFlowPrices(JSON.stringify([
      { startsAt: '2026-09-25T00:00:00+02:00', total: 0.52 },
      { startsAt: '2026-09-25T01:00:00+02:00', total: 0.48 },
    ]));
    assert.equal(hourly[0].end.toISOString(), '2026-09-24T23:00:00.000Z', 'runs until the next entry');
    assert.equal(hourly[1].end.getTime() - hourly[1].start.getTime(), 3_600_000, 'last entry as long as the one before');
    const elpriset = parseFlowPrices(JSON.stringify([
      { time_start: '2026-09-25T00:00:00+02:00', time_end: '2026-09-25T00:15:00+02:00', SEK_per_kWh: 1.2 },
    ]));
    assert.equal(elpriset[0].end.getTime() - elpriset[0].start.getTime(), 900_000);
    assert.throws(() => parseFlowPrices('not json'), /JSON/);
    assert.throws(() => parseFlowPrices('[{"start":"x","price":1}]'), /Unreadable/);
  });

  it('serves flow prices per local day', async () => {
    const flow = new FlowPriceProvider(TZ);
    flow.merge(parseFlowPrices(JSON.stringify([
      { start: '2026-09-25T23:00:00+02:00', price: 1 },
      { start: '2026-09-26T00:00:00+02:00', price: 2 },
    ])));
    assert.equal((await flow.getDay('2026-09-25'))?.length, 4);
    assert.equal((await flow.getDay('2026-09-26'))?.[0].perKwh, 2);
    assert.equal(await flow.getDay('2026-09-27'), null);
  });
});

describe('solar sources', () => {
  it('interpolates Forecast.Solar points to quarter averages', () => {
    const t = (hhmm: string) => new Date(`2026-09-24T${hhmm}:00Z`).getTime();
    const q = pointsToQuarters([[t('05:00'), 0], [t('06:00'), 1000], [t('07:00'), 3000]]);
    assert.ok(Math.abs(q.get(t('05:00'))! - 0.125) < 1e-9, 'middle of 05:00–05:15 is 1/8 of the way to 1 kW');
    assert.ok(Math.abs(q.get(t('06:15'))! - 1.75) < 1e-9);
    assert.equal(q.has(t('07:00')), false, 'nothing after the last point');
  });

  it("blends weather models by the median, so one model's miss does not count (25 Sep noon)", () => {
    const models = ['icon_seamless', 'ecmwf_ifs025', 'gfs_seamless', 'metno_seamless', 'meteofrance_seamless'];
    const q = parseBlend({ hourly: {
      time: ['2026-09-25T10:00'],
      global_tilted_irradiance_icon_seamless: [579], global_tilted_irradiance_ecmwf_ifs025: [379],
      global_tilted_irradiance_gfs_seamless: [642], global_tilted_irradiance_metno_seamless: [68],
      global_tilted_irradiance_meteofrance_seamless: [null],
      temperature_2m_icon_seamless: [14], temperature_2m_gfs_seamless: [16],
    } }, models);
    assert.equal(q.length, 4, 'the hour before 10:00 UTC as four quarters');
    assert.equal(q[0].start.toISOString(), '2026-09-25T09:00:00.000Z');
    assert.equal(q[0].gti, (379 + 579) / 2, 'median of the four models with data');
    assert.equal(q[0].tempC, 15);
    assert.equal(median([]), null);
  });

  it('reads Solcast half-hour periods', () => {
    const q = parseSolcast({ forecasts: [{ pv_estimate: 2.5, period_end: '2026-09-24T10:30:00Z', period: 'PT30M' }] });
    assert.equal(q.get(new Date('2026-09-24T10:00:00Z').getTime()), 2.5);
    assert.equal(q.get(new Date('2026-09-24T10:15:00Z').getTime()), 2.5);
    assert.equal(q.size, 2);
  });
});

describe('MET Norway warnings', () => {
  const square = { type: 'Polygon' as const, coordinates: [[[10, 59], [11, 59], [11, 60], [10, 60], [10, 59]]] };
  const feature = (props: Record<string, string>) => ({
    properties: { id: props.id, area: 'Oslo', eventAwarenessName: 'Wind', geographicDomain: 'land', awareness_type: '1; Wind', ...props },
    when: { interval: ['2026-09-24T12:00:00+00:00', '2026-09-25T12:00:00+00:00'] },
    geometry: square,
  });
  const filter = { minLevel: 'YELLOW' as const, weatherOnly: true, leadHours: 12 };

  it('keeps land warnings at the chosen level that cover the point', () => {
    const json = {
      features: [
        feature({ id: 'a', awareness_level: '2; yellow; Moderate' }),
        feature({ id: 'b', awareness_level: '3; orange; Severe', geographicDomain: 'marine' }),
        feature({ id: 'c', awareness_level: '3; orange; Severe', awareness_type: '8; forest-fire' }),
      ],
    };
    const warnings = parseMetNoWarnings(json, 59.9, 10.7, new Date('2026-09-24T18:00:00Z'), filter);
    assert.deepEqual(warnings.map((w) => w.id), ['a']);
    assert.equal(warnings[0].level, 'YELLOW');
    assert.deepEqual(parseMetNoWarnings(json, 62, 10.7, new Date('2026-09-24T18:00:00Z'), filter), [], 'outside the area');
  });
});

describe('inverter support', () => {
  class FakeDetail extends SolisCloudClient {
    constructor(private readonly detail: Record<string, unknown>, private readonly marker: string) {
      super({ keyId: 'k', keySecret: 's' });
    }

    override async inverterDetail(): Promise<Record<string, unknown>> {
      return this.detail;
    }

    override async read(): Promise<string> {
      return this.marker;
    }
  }

  it('recognises a hybrid with the 6-slot schedule', async () => {
    const info = await inspectInverter(new FakeDetail({
      machine: 'S6-EH3P20K-H', productModel: '3316', power: 20, powerStr: 'kW', energyStorageControl: '31',
      hmiVersionAll: '1262', dspmVersionAll: '0945', collectorModel: 'WL',
    }, '43605'), 'SN');
    assert.equal(info.model, 'S6-EH3P20K-H');
    assert.equal(info.ratedPowerKw, 20);
    assert.equal(info.firmware, 'HMI 1262 · DSP 0945');
    assert.equal(supportLevel(info), 'full');
  });

  it('supports older schedule firmware in the basic way and string inverters not at all', () => {
    const base: InverterInfo = { model: 'X', modelCode: '', ratedPowerKw: 5, firmware: '', dataLogger: '', hybrid: true, touV2: false };
    assert.equal(supportLevel(base), 'basic');
    assert.equal(supportLevel({ ...base, hybrid: false }), 'unsupported');
  });
});
