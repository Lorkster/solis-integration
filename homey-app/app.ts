import Homey from 'homey';

import type { BatteryPlannerDevice } from './lib/homey/BatteryPlannerDevice.js';
import { inverterDevices } from './lib/homey/EnergyChildDevice.js';
import { registerFlowCards } from './lib/homey/flowCards.js';

export default class BatteryPlannerApp extends Homey.App {
  override async onInit(): Promise<void> {
    registerFlowCards(this.homey.flow);
    this.log('Home Battery Planner started');
  }

  /** State of the first paired inverter (any brand), for the dashboard widgets and the dashboard page. */
  getView(): unknown {
    const [device] = inverterDevices<BatteryPlannerDevice>(this.homey);
    return device ? device.getView() : { ready: false, paired: false };
  }
}
