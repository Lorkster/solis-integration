import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Irradiance, IrradiancePowerProvider, type IrradianceProvider, looksCurtailed, modelPvKw, type SolarArray, SolarCalibration, SolarForecaster } from '../lib/forecast/SolarForecast.js';
import { containsPoint, parseWarnings } from '../lib/warnings/SmhiWarnings.js';
import { TZ } from './helpers.js';

describe('solar model', () => {
  it('derates for cell temperature', () => {
    const kw = modelPvKw({ start: new Date(), gti: 1000, tempC: 25 }, { kwp: 11, tilt: 35, azimuth: 0 }, 0.85);
    // Cell at 25 + 1000/800*20 = 50 °C → factor 1 - 0.004 * 25 = 0.9
    assert.ok(Math.abs(kw - 11 * 0.85 * 0.9) < 1e-9);
    assert.equal(modelPvKw({ start: new Date(), gti: 0, tempC: 10 }, { kwp: 11, tilt: 35, azimuth: 0 }, 0.85), 0);
  });

  it('learns an hourly correction factor from measurements', () => {
    const calibration = new SolarCalibration(TZ);
    const afternoon = new Date('2026-09-20T16:00:00+02:00');
    assert.equal(calibration.factorAt(afternoon), 1, 'neutral before data');
    for (let day = 0; day < 10; day++) {
      const t = new Date(afternoon.getTime() + day * 86_400_000);
      calibration.add(t, 4, 1.6, 11); // shaded: 40 % of the model
    }
    assert.ok(Math.abs(calibration.factorAt(afternoon) - 0.4) < 1e-9);
    calibration.add(afternoon, 0.5, 5, 11); // low light: ignored
    assert.ok(Math.abs(calibration.factorAt(afternoon) - 0.4) < 1e-9);
  });

  it('recognises throttled solar', () => {
    assert.ok(looksCurtailed(2.25, 2.23, 0, 0), 'solar equals load, no export, battery idle');
    assert.ok(!looksCurtailed(5.0, 2.5, -2.4, 0), 'exporting freely');
    assert.ok(!looksCurtailed(5.0, 2.5, 0, 2.4), 'surplus goes into the battery');
    assert.ok(!looksCurtailed(1.2, 2.5, 1.3, 0), 'solar below load: sun-limited');
  });

  it('sums arrays and applies calibration', async () => {
    const start = new Date('2026-09-24T10:00:00Z');
    const provider: IrradianceProvider = {
      async get(_lat: number, _lon: number, array: SolarArray): Promise<Irradiance[]> {
        return [{ start, gti: array.azimuth === 0 ? 800 : 400, tempC: 15 }];
      },
    };
    const forecaster = new SolarForecaster({
      latitude: 59.8, longitude: 17, performanceRatio: 0.85, maxAcKw: 20,
      arrays: [{ kwp: 6, tilt: 35, azimuth: 0 }, { kwp: 5, tilt: 35, azimuth: -90 }],
    }, new SolarCalibration(TZ), new IrradiancePowerProvider(provider));
    await forecaster.refresh();
    const expected = modelPvKw({ start, gti: 800, tempC: 15 }, { kwp: 6, tilt: 35, azimuth: 0 }, 0.85)
      + modelPvKw({ start, gti: 400, tempC: 15 }, { kwp: 5, tilt: 35, azimuth: -90 }, 0.85);
    assert.ok(Math.abs(forecaster.forecastAt(new Date('2026-09-24T10:07:00Z'))! - expected) < 1e-9);
    assert.equal(forecaster.forecastAt(new Date('2026-09-24T12:00:00Z')), null);
  });
});

describe('solar nowcast', () => {
  it('corrects the next hours by what the panels deliver now, fading out', async () => {
    const now = new Date();
    const q = Math.floor(now.getTime() / 900_000) * 900_000;
    const provider = { hasHistory: false, getPower: async () => new Map(Array.from({ length: 24 }, (_, i) => [q + i * 900_000, 2] as [number, number])) };
    const forecaster = new SolarForecaster({ latitude: 59.8, longitude: 17, performanceRatio: 0.85, maxAcKw: 20, arrays: [{ kwp: 11, tilt: 35, azimuth: 0 }] },
      new SolarCalibration(TZ), provider);
    await forecaster.refresh();
    assert.equal(forecaster.forecastAt(now), 2);
    forecaster.observe(now, 3.3); // sunnier than forecast
    assert.ok(Math.abs(forecaster.forecastAt(now)! - 3.3) < 0.05);
    const later = forecaster.forecastAt(new Date(q + 4 * 3_600_000 - 900_000))!;
    assert.ok(later > 2 && later < 2.3, 'fades towards the forecast over a few hours');
  });
});

describe('SMHI warnings', () => {
  // A square around 59.5–60.0 N, 16.5–17.5 E (lon, lat order as in GeoJSON).
  const square = { type: 'Polygon' as const, coordinates: [[[16.5, 59.5], [17.5, 59.5], [17.5, 60.0], [16.5, 60.0], [16.5, 59.5]]] };
  const now = new Date('2026-10-10T12:00:00Z');
  const raw = [
    {
      event: { code: 'WIND', en: 'Wind', mhoClassification: { code: 'MET' } },
      warningAreas: [{
        id: 1, warningLevel: { code: 'YELLOW' as const }, approximateStart: '2026-10-10T18:00:00Z', approximateEnd: '2026-10-11T06:00:00Z',
        areaName: { en: 'Uppsala County' }, eventDescription: { en: 'Strong wind gusts' }, area: { geometry: square },
      }],
    },
    {
      event: { code: 'WATER_SHORTAGE', en: 'Water shortage', mhoClassification: { code: 'HYD' } },
      warningAreas: [{ id: 2, warningLevel: { code: 'MESSAGE' as const }, area: { geometry: square } }],
    },
  ];

  it('tests points against polygons and multipolygons', () => {
    assert.ok(containsPoint(square, 59.78, 17.0));
    assert.ok(!containsPoint(square, 58.0, 17.0));
    assert.ok(containsPoint({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], square.coordinates] }, 59.78, 17.0));
  });

  it('keeps relevant warnings for the location', () => {
    const found = parseWarnings(raw, 59.78, 17.0, now, { minLevel: 'YELLOW', weatherOnly: true, leadHours: 12 });
    assert.equal(found.length, 1);
    assert.equal(found[0].title, 'Strong wind gusts');
    assert.equal(found[0].end?.toISOString(), '2026-10-11T06:00:00.000Z');
  });

  it('filters by location, level, category and lead time', () => {
    const filter = { minLevel: 'YELLOW' as const, weatherOnly: true, leadHours: 12 };
    assert.equal(parseWarnings(raw, 57.0, 12.0, now, filter).length, 0, 'outside the area');
    assert.equal(parseWarnings(raw, 59.78, 17.0, now, { ...filter, minLevel: 'ORANGE' }).length, 0, 'below level');
    assert.equal(parseWarnings(raw, 59.78, 17.0, now, { ...filter, leadHours: 2 }).length, 0, 'starts too late');
    assert.equal(parseWarnings(raw, 59.78, 17.0, new Date('2026-10-11T07:00:00Z'), filter).length, 0, 'already ended');
    assert.equal(parseWarnings(raw, 59.78, 17.0, now, { minLevel: 'MESSAGE', weatherOnly: false, leadHours: 12 }).length, 2);
  });
});
