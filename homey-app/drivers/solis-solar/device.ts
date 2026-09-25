import { EnergyChildDevice } from '../../lib/homey/EnergyChildDevice.js';
import type { LiveData } from '../../lib/inverter/types.js';

/** Solar production for Homey Energy: power (positive while producing) and lifetime kWh. */
export default class SolarDevice extends EnergyChildDevice {
  protected async update(live: LiveData): Promise<void> {
    await this.set('measure_power', Math.max(0, live.pvPowerW));
    await this.set('meter_power', live.pvTotalKwh);
  }
}
