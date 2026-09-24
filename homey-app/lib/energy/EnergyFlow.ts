/**
 * Where the house's power comes from right now, and what one more kWh would cost.
 *
 * The inverter reports raw flows (solar, battery, grid, house). For automations the useful
 * questions are simpler: is the house running on solar, battery or grid, is there solar to spare,
 * and is it cheap to use more power right now?
 */

export type PowerSource =
  | 'solar' | 'solar_battery' | 'battery' | 'grid' | 'solar_grid' | 'battery_grid' | 'solar_battery_grid' | 'none';

export const POWER_SOURCES: readonly PowerSource[] = [
  'solar', 'solar_battery', 'battery', 'grid', 'solar_grid', 'battery_grid', 'solar_battery_grid', 'none',
];

export interface Flows {
  pvW: number;
  loadW: number;
  gridW: number; // positive = import
  batteryW: number; // positive = charging
}

export interface HouseSupply {
  /** Power delivered to the house by each source, in W. */
  fromSolarW: number;
  fromBatteryW: number;
  fromGridW: number;
  /** Share of the house load per source, in % (0-100, sums to 100 when the house uses power). */
  solarPct: number;
  batteryPct: number;
  gridPct: number;
  /** Solar production beyond the house load, going into the battery or to the grid, in W. */
  surplusW: number;
  source: PowerSource;
}

/** A source counts as "in use" above this power and share, so noise does not flip the state. */
const MIN_SOURCE_W = 100;
const MIN_SOURCE_SHARE = 0.05;

/**
 * Splits the house load over its sources. Solar serves the house first (self-use), then the
 * battery, and the grid covers the rest.
 */
export function houseSupply(f: Flows): HouseSupply {
  const load = Math.max(0, f.loadW);
  const pv = Math.max(0, f.pvW);
  const fromSolarW = Math.min(pv, load);
  const fromBatteryW = Math.min(Math.max(0, -f.batteryW), load - fromSolarW);
  const fromGridW = Math.max(0, load - fromSolarW - fromBatteryW);
  const pct = (w: number) => (load > 0 ? Math.round((w / load) * 100) : 0);

  const used = (w: number) => w >= MIN_SOURCE_W && w >= load * MIN_SOURCE_SHARE;
  const parts = [used(fromSolarW) && 'solar', used(fromBatteryW) && 'battery', used(fromGridW) && 'grid'].filter(Boolean);
  const source = (parts.length ? parts.join('_') : 'none') as PowerSource;

  return {
    fromSolarW,
    fromBatteryW,
    fromGridW,
    solarPct: pct(fromSolarW),
    batteryPct: pct(fromBatteryW),
    gridPct: pct(fromGridW),
    surplusW: Math.max(0, pv - load),
    source,
  };
}

export function usesSource(source: PowerSource, part: 'solar' | 'battery' | 'grid'): boolean {
  return source.split('_').includes(part);
}

/** Grid flows below this are treated as "balanced" (the inverter regulates around zero). */
const GRID_DEADBAND_W = 150;

/**
 * What using one more kWh right now costs, in SEK/kWh:
 *  - importing from the grid: the import price now;
 *  - exporting solar: the export price now (the income you give up);
 *  - otherwise the battery absorbs the difference: the value of stored energy, i.e. what the plan
 *    would pay later to replace it (from the optimiser).
 */
export function extraPowerCost(gridW: number, buyNow: number, sellNow: number, storedEnergyValue: number): number {
  if (gridW > GRID_DEADBAND_W) return buyNow;
  if (gridW < -GRID_DEADBAND_W) return sellNow;
  return storedEnergyValue;
}
