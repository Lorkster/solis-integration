import { EnergyChildDevice } from '../../lib/homey/EnergyChildDevice.js';
import type { LiveData } from '../../lib/inverter/types.js';

/** The grid connection for Homey Energy: power (+ buying, − selling) and lifetime kWh each way. */
export default class GridDevice extends EnergyChildDevice {
  protected async update(live: LiveData): Promise<void> {
    await this.set('measure_power', live.gridLost ? 0 : live.gridPowerW);
    await this.set('meter_power.imported', live.gridImportTotalKwh);
    await this.set('meter_power.exported', live.gridExportTotalKwh);
  }
}
