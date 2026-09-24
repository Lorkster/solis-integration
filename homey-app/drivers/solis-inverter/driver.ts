import Homey from 'homey';

import { supportLevel } from '../../lib/inverter/types.js';
import { discoverInverters, listInverters } from '../../lib/solis/SolisCloudTransport.js';
import type SolisInverterDevice from './device.js';

type DeviceArgs<T = object> = T & { device: SolisInverterDevice };

export default class SolisInverterDriver extends Homey.Driver {
  override async onInit(): Promise<void> {
    const flow = this.homey.flow;

    flow.getConditionCard('house_powered_by')
      .registerRunListener(async ({ device, source }: DeviceArgs<{ source: 'solar' | 'battery' | 'grid' }>) => device.usesSource(source));
    flow.getConditionCard('solar_surplus_above')
      .registerRunListener(async ({ device, watts }: DeviceArgs<{ watts: number }>) => device.solarSurplusW() > watts);
    flow.getConditionCard('power_cost_below')
      .registerRunListener(async ({ device, price }: DeviceArgs<{ price: number }>) => {
        const cost = device.extraPowerCost();
        return cost !== null && cost < price;
      });
    flow.getConditionCard('planned_action_is')
      .registerRunListener(async ({ device, action }: DeviceArgs<{ action: string }>) => device.currentAction() === action);
    flow.getConditionCard('price_among_cheapest')
      .registerRunListener(async ({ device, hours }: DeviceArgs<{ hours: number }>) => device.isPriceAmongCheapest(hours));

    flow.getActionCard('set_control_mode')
      .registerRunListener(async ({ device, mode }: DeviceArgs<{ mode: 'monitor' | 'auto' }>) => device.setControlMode(mode));
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
    flow.getActionCard('set_prices')
      .registerRunListener(async ({ device, prices }: DeviceArgs<{ prices: string }>) => device.setFlowPrices(prices));
    flow.getActionCard('replan_now')
      .registerRunListener(async ({ device }: DeviceArgs) => device.setControlMode(device.controlMode));
  }

  override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    let keyId = '';
    let keySecret = '';

    session.setHandler('login', async ({ username, password }: { username: string; password: string }) => {
      keyId = username.trim();
      keySecret = password.trim();
      await listInverters({ keyId, keySecret }); // throws with the API error message if invalid
      return true;
    });

    session.setHandler('list_devices', async () => {
      const inverters = (await discoverInverters({ keyId, keySecret })).filter((inv) => supportLevel(inv.info) !== 'unsupported');
      if (inverters.length === 0) throw new Error(this.homey.__('device.noHybrid'));
      // A plain name for everyday use; the model and firmware are in the device settings.
      const name = this.homey.__('device.name');
      return inverters.map((inv) => ({
        name: inverters.length > 1 ? `${name} (${inv.name})` : name,
        data: { id: inv.serialNumber },
        settings: { key_id: keyId, key_secret: keySecret },
      }));
    });
  }
}
