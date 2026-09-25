import Homey from 'homey';

import type SolisInverterDevice from './drivers/solis-inverter/device.js';

export default class SolisBatteryApp extends Homey.App {
  override async onInit(): Promise<void> {
    this.log('Solis Smart Battery started');
  }

  /** State of the first paired inverter, for the dashboard widgets and the dashboard page. */
  getView(): unknown {
    const [device] = this.homey.drivers.getDriver('solis-inverter').getDevices() as SolisInverterDevice[];
    return device ? device.getView() : { ready: false, paired: false };
  }
}
