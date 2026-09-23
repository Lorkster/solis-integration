import Homey from 'homey';

import type SolisInverterDevice from './drivers/solis-inverter/device.js';

export default class SolisBatteryApp extends Homey.App {
  override async onInit(): Promise<void> {
    this.log('Solis Smart Battery started');
  }

  /** Plan of the first paired inverter, for the dashboard widget. */
  getPlanView(): unknown {
    const [device] = this.homey.drivers.getDriver('solis-inverter').getDevices() as SolisInverterDevice[];
    return device ? device.getPlanView() : { ready: false, reason: 'No inverter paired' };
  }
}
