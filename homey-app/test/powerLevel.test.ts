import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  alternativeCheaper, breakEvenCost, heatPumpCop, levelLimits, type PowerLevelConfig, powerLevel,
} from '../lib/energy/PowerLevel.js';

const auto: PowerLevelConfig = { mode: 'auto', sharePct: 25, cheapBelow: 1, expensiveAbove: 2.5 };

describe('cheap, normal or expensive', () => {
  // 24 hours of quarters: 0.50, 0.55, … rising by 0.05 an hour.
  const prices = Array.from({ length: 96 }, (_, i) => 0.5 + Math.floor(i / 4) * 0.05);

  it('takes the cheapest and priciest quarter of the next 24 hours', () => {
    const limits = levelLimits(prices, auto)!;
    assert.equal(Math.round(limits.cheapBelow * 100) / 100, 0.75); // the 24th cheapest quarter
    assert.equal(Math.round(limits.expensiveAbove * 100) / 100, 1.4);
    assert.equal(powerLevel(0.3, limits), 'cheap', 'solar that would be exported for 0.30');
    assert.equal(powerLevel(1.1, limits), 'normal');
    assert.equal(powerLevel(1.6, limits), 'expensive');
  });

  it('uses manual limits as set', () => {
    const limits = levelLimits(prices, { ...auto, mode: 'manual' })!;
    assert.deepEqual(limits, { cheapBelow: 1, expensiveAbove: 2.5 });
    assert.equal(powerLevel(2.61, limits), 'expensive');
  });

  it('calls a flat day normal', () => {
    const limits = levelLimits(Array(96).fill(1.2), auto)!;
    assert.equal(powerLevel(1.2, limits), 'normal');
    assert.equal(levelLimits([1, 2], auto), null, 'too few prices');
  });

  it('does not flip back and forth around a limit', () => {
    const limits = { cheapBelow: 0.8, expensiveAbove: 1.4 }; // margin 0.03
    assert.equal(powerLevel(0.82, limits, 'cheap'), 'cheap');
    assert.equal(powerLevel(0.84, limits, 'cheap'), 'normal');
    assert.equal(powerLevel(1.38, limits, 'expensive'), 'expensive');
    assert.equal(powerLevel(1.36, limits, 'expensive'), 'normal');
    assert.equal(powerLevel(0.82, limits, 'normal'), 'normal');
  });
});

describe('heat pump or wood', () => {
  // Firewood 1000 kr per m³ loose, about 1000 kWh, 70 % stove efficiency: 1.43 kr per kWh of heat.
  const wood = { costPerKwh: 1000 / (1000 * 0.7), copAt7: 4, copAtMinus7: 2.6 };

  it('follows the data sheet COP with the outdoor temperature', () => {
    assert.equal(heatPumpCop(7, wood), 4);
    assert.equal(heatPumpCop(-7, wood), 2.6);
    assert.equal(heatPumpCop(0, wood), 3.3);
    assert.equal(heatPumpCop(null, wood), 3.3, 'unknown: as at 0 °C');
    assert.equal(heatPumpCop(-60, wood), 1, 'never below 1 (direct electric heat)');
  });

  it('electricity must cost more than wood heat × COP before the stove is cheaper', () => {
    const coldDay = breakEvenCost(-7, wood)!;
    assert.equal(Math.round(coldDay * 100) / 100, 3.71);
    assert.equal(alternativeCheaper(2.61, coldDay), false);
    assert.equal(alternativeCheaper(4.2, coldDay), true);
    assert.equal(alternativeCheaper(3.65, coldDay, true), true, 'stays until 3 % below');
    assert.equal(alternativeCheaper(3.55, coldDay, true), false);
    assert.equal(breakEvenCost(0, { ...wood, costPerKwh: 0 }), null, 'no alternative set');
    assert.equal(alternativeCheaper(10, null), false);
  });
});
