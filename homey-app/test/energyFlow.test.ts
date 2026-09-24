import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { extraPowerCost, houseSupply, usesSource } from '../lib/energy/EnergyFlow.js';

describe('houseSupply', () => {
  it('solar covers the house and the surplus charges the battery', () => {
    const s = houseSupply({ pvW: 5000, loadW: 2000, gridW: 0, batteryW: 3000 });
    assert.equal(s.source, 'solar');
    assert.equal(s.solarPct, 100);
    assert.equal(s.surplusW, 3000);
  });

  it('battery tops up weak solar (24 Sep 15:57)', () => {
    const s = houseSupply({ pvW: 258, loadW: 1938, gridW: 0, batteryW: -1705 });
    assert.equal(s.source, 'solar_battery');
    assert.equal(s.fromBatteryW, 1680);
    assert.equal(s.gridPct, 0);
  });

  it('locked battery: the grid covers the house (24 Sep 08:00)', () => {
    const s = houseSupply({ pvW: 660, loadW: 1930, gridW: 1270, batteryW: 0 });
    assert.equal(s.source, 'solar_grid');
    assert.ok(usesSource(s.source, 'grid') && !usesSource(s.source, 'battery'));
  });

  it('ignores trickles below the noise threshold', () => {
    const s = houseSupply({ pvW: 40, loadW: 2000, gridW: 1960, batteryW: 0 });
    assert.equal(s.source, 'grid');
    assert.equal(houseSupply({ pvW: 0, loadW: 0, gridW: 0, batteryW: 0 }).source, 'none');
  });
});

describe('extraPowerCost', () => {
  it('uses the price of the source that absorbs the extra kWh', () => {
    assert.equal(extraPowerCost(1200, 3.8, 1.6, 2.7), 3.8, 'importing: buy price');
    assert.equal(extraPowerCost(-2400, 2.6, 1.3, 2.7), 1.3, 'exporting solar: lost export income');
    assert.equal(extraPowerCost(20, 4.1, 2.5, 2.7), 2.7, 'battery balancing: value of stored energy');
  });
});
