import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ModelSkill } from '../lib/forecast/ModelSkill.js';
import { type PvPowerProvider, SolarCalibration, SolarForecaster } from '../lib/forecast/SolarForecast.js';
import { TZ } from './helpers.js';

const KWP = 9.4;

describe('weather model skill', () => {
  it('weights the models that match the measured production most', () => {
    const skill = new ModelSkill();
    assert.equal(skill.weights(['yr', 'icon'], KWP), null, 'no weights before there is data');
    for (let i = 0; i < 100; i++) skill.add({ yr: 5.2, icon: 3.0 }, 5.0, KWP); // Yr 0.2 kW off, ICON 2 kW off
    const w = skill.weights(['yr', 'icon'], KWP)!;
    assert.ok(w.yr > 0.75 && w.icon > 0.1, `Yr leads, ICON keeps a share: ${JSON.stringify(w)}`);
    assert.ok(Math.abs(w.yr + w.icon - 1) < 1e-9);
    assert.equal(skill.describe(['yr', 'icon'], KWP), `yr ${Math.round(w.yr * 100)} % · icon ${Math.round(w.icon * 100)} %`);
  });

  it('ignores darkness and adapts when another model starts doing better', () => {
    const skill = new ModelSkill(undefined, 0.95, 10);
    for (let i = 0; i < 50; i++) skill.add({ yr: 0, icon: 0.1 }, 0, KWP); // night: every model is right
    assert.equal(skill.weights(['yr', 'icon'], KWP), null);
    for (let i = 0; i < 50; i++) skill.add({ yr: 4, icon: 6 }, 4, KWP);
    assert.ok(skill.weights(['yr', 'icon'], KWP)!.yr > 0.5);
    for (let i = 0; i < 100; i++) skill.add({ yr: 2, icon: 6 }, 6, KWP); // a cloudy-forecast miss season
    assert.ok(skill.weights(['yr', 'icon'], KWP)!.icon > 0.5, 'recent quarters count most');
  });

  it('gives a model without enough data the average weight', () => {
    const skill = new ModelSkill(undefined, 0.995, 10);
    for (let i = 0; i < 20; i++) skill.add({ a: 5, b: 4 }, 5, KWP);
    const w = skill.weights(['a', 'b', 'c'], KWP)!;
    assert.ok(w.c > w.b && w.c < w.a, JSON.stringify(w));
  });
});

describe('forecast from several weather models', () => {
  const t0 = Math.floor(Date.now() / 900_000) * 900_000;
  const provider: PvPowerProvider = {
    hasHistory: true,
    getPower: async () => new Map(),
    getModelPower: async () => new Map([
      ['yr', new Map([[t0, 0.7]])], // 25 Sep: Yr forecast grey skies
      ['icon', new Map([[t0, 5.8]])],
      ['gfs', new Map([[t0, 6.4]])],
    ]),
  };
  const config = { latitude: 59.8, longitude: 17, performanceRatio: 0.85, maxAcKw: 20, arrays: [{ kwp: KWP, tilt: 30, azimuth: -30 }] };

  it('uses the median while learning, then the learned weights', async () => {
    const learning = new SolarForecaster(config, new SolarCalibration(TZ), provider);
    await learning.refresh();
    assert.equal(learning.modeledAt(new Date(t0)), 5.8, 'median of 0.7, 5.8 and 6.4');
    assert.equal(learning.describeWeights(), null);

    const skill = new ModelSkill();
    for (let i = 0; i < 100; i++) skill.add({ yr: 6.0, icon: 3.0, gfs: 3.5 }, 6.0, KWP); // Yr has been right here
    const learned = new SolarForecaster(config, new SolarCalibration(TZ), provider, skill);
    await learned.refresh();
    const v = learned.modeledAt(new Date(t0))!;
    assert.ok(v < 5.8, `weighted towards Yr: ${v}`);
    assert.match(learned.describeWeights()!, /^yr \d+ %/);
  });

  it('scores each model on measured quarters, after the calibration', async () => {
    const f = new SolarForecaster(config, new SolarCalibration(TZ), provider, new ModelSkill(undefined, 0.995, 1));
    await f.refresh();
    f.learn(new Date(t0), 6.0);
    assert.ok(f.skill.mae('gfs')! < f.skill.mae('yr')!, 'GFS was closest to the 6.0 kW measured');
  });
});
