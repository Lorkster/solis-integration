import Homey from 'homey';

import type { PowerLevel } from '../energy/PowerLevel.js';
import type { BatteryPlannerDevice, BestTimeArgs, ControlMode } from './BatteryPlannerDevice.js';

type DeviceArgs<T = object> = T & { device: BatteryPlannerDevice };

/**
 * Flow cards are app-wide (.homeycompose/flow); their device argument lists every brand's inverter
 * driver, and the cards call the shared BatteryPlannerDevice.
 */
export function registerFlowCards(flow: Homey.App['homey']['flow']): void {
  flow.getConditionCard('house_powered_by')
    .registerRunListener(async ({ device, source }: DeviceArgs<{ source: 'solar' | 'battery' | 'grid' }>) => device.usesSource(source));
  flow.getConditionCard('solar_surplus_above')
    .registerRunListener(async ({ device, watts }: DeviceArgs<{ watts: number }>) => device.solarSurplusW() > watts);
  flow.getConditionCard('power_cost_below')
    .registerRunListener(async ({ device, price }: DeviceArgs<{ price: number }>) => {
      const cost = device.extraPowerCost();
      return cost !== null && cost < price;
    });
  flow.getConditionCard('power_level_is')
    .registerRunListener(async ({ device, level }: DeviceArgs<{ level: PowerLevel }>) => device.powerLevel() === level);
  flow.getConditionCard('heat_pump_cheaper')
    .registerRunListener(async ({ device }: DeviceArgs) => device.otherHeatingCheaper() === false);
  flow.getConditionCard('planned_action_is')
    .registerRunListener(async ({ device, action }: DeviceArgs<{ action: string }>) => device.currentAction() === action);
  flow.getConditionCard('price_among_cheapest')
    .registerRunListener(async ({ device, hours }: DeviceArgs<{ hours: number }>) => device.isPriceAmongCheapest(hours));

  flow.getActionCard('set_control_mode')
    .registerRunListener(async ({ device, mode }: DeviceArgs<{ mode: ControlMode }>) => device.setControlMode(mode));
  flow.getActionCard('force_charge')
    .registerRunListener(async ({ device, minutes }: DeviceArgs<{ minutes: number }>) => device.addOverride('charge', minutes));
  flow.getActionCard('hold_battery')
    .registerRunListener(async ({ device, minutes }: DeviceArgs<{ minutes: number }>) => device.addOverride('hold', minutes));
  flow.getActionCard('prepare_outage')
    .registerRunListener(async ({ device, hours }: DeviceArgs<{ hours: number }>) => device.prepareOutage(hours));
  flow.getActionCard('clear_overrides')
    .registerRunListener(async ({ device }: DeviceArgs) => device.clearOverrides());
  flow.getConditionCard('weather_warning_active')
    .registerRunListener(async ({ device }: DeviceArgs) => device.hasWeatherWarning());
  flow.getActionCard('restore_inverter')
    .registerRunListener(async ({ device }: DeviceArgs) => device.restoreInverter());
  flow.getConditionCard('power_cut_active')
    .registerRunListener(async ({ device }: DeviceArgs) => device.isPowerCut());
  flow.getConditionCard('peak_risk_active')
    .registerRunListener(async ({ device }: DeviceArgs) => device.isPeakRisk());
  const sameRun = (a: BestTimeArgs, b: BestTimeArgs) => Number(a.minutes) === Number(b.minutes)
    && Number(a.power) === Number(b.power) && a.deadline === b.deadline;
  flow.getDeviceTriggerCard('best_time_to_run')
    .registerRunListener(async (args: DeviceArgs<BestTimeArgs>, state: BestTimeArgs) => sameRun(args, state));
  flow.getConditionCard('best_time_now')
    .registerRunListener(async ({ device, ...args }: DeviceArgs<BestTimeArgs>) => device.isBestTimeNow(args));
  flow.getActionCard('find_best_time')
    .registerRunListener(async ({ device, ...args }: DeviceArgs<BestTimeArgs>) => device.findBestTime(args));
  flow.getActionCard('set_prices')
    .registerRunListener(async ({ device, prices }: DeviceArgs<{ prices: string }>) => device.setFlowPrices(prices));
  flow.getActionCard('replan_now')
    .registerRunListener(async ({ device }: DeviceArgs) => device.setControlMode(device.controlMode));
}
