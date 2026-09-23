import Homey from 'homey';

import { listInverters } from '../../lib/solis/SolisCloudTransport.js';
import type SolisInverterDevice from './device.js';

type DeviceArgs<T = object> = T & { device: SolisInverterDevice };

export default class SolisInverterDriver extends Homey.Driver {
  override async onInit(): Promise<void> {
    const flow = this.homey.flow;

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
      const inverters = await listInverters({ keyId, keySecret });
      return inverters.map((inv) => ({
        name: `${inv.model} (${inv.name})`,
        data: { id: inv.serialNumber },
        settings: { key_id: keyId, key_secret: keySecret },
      }));
    });
  }
}
