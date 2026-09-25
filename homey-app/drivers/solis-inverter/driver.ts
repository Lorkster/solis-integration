import Homey from 'homey';

import { discoverInverters, listInverters } from '../../lib/brands/solis/SolisCloudTransport.js';
import { SolisModbusTransport } from '../../lib/brands/solis/SolisModbusTransport.js';
import { type InverterInfo, supportLevel } from '../../lib/inverter/types.js';
import { ModbusTcpClient } from '../../lib/modbus/ModbusTcpClient.js';
import { suggestPriceArea } from '../../lib/prices/areas.js';

/** Pairing a Solis hybrid inverter through SolisCloud or Modbus. The flow cards are app-wide (lib/homey/flowCards.ts). */
export default class SolisInverterDriver extends Homey.Driver {
  override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    let keyId = '';
    let keySecret = '';
    let modbus: { host: string; port: number; unit: number } | null = null;
    let modbusDevice: { serial: string; info: InverterInfo } | null = null;

    session.setHandler('modbus', async (target: { host: string; port: number; unit: number }) => {
      const transport = new SolisModbusTransport(new ModbusTcpClient({ ...target, timeoutMs: 10_000 }));
      const info = await transport.getInfo();
      if (!info.hybrid) throw new Error(this.homey.__('device.noHybrid'));
      modbusDevice = { serial: await transport.getSerialNumber(), info };
      modbus = target;
      return true;
    });

    session.setHandler('login', async ({ username, password }: { username: string; password: string }) => {
      keyId = username.trim();
      keySecret = password.trim();
      await listInverters({ keyId, keySecret }); // throws with the API error message if invalid
      return true;
    });

    session.setHandler('list_devices', async () => {
      // Start from the price area where Homey is; the user can change it in the settings.
      const guess = suggestPriceArea(this.homey.clock.getTimezone(), this.homey.geolocation.getLatitude(), this.homey.geolocation.getLongitude());
      const priceSettings = guess ? { price_area: guess.area, price_source: guess.source } : {};
      if (modbus && modbusDevice) {
        return [{
          name: this.homey.__('device.name'),
          data: { id: modbusDevice.serial },
          settings: {
            connection_primary: 'modbus', modbus_host: modbus.host, modbus_port: modbus.port, modbus_unit: modbus.unit,
            key_id: '', key_secret: '', ...priceSettings,
          },
        }];
      }
      const inverters = (await discoverInverters({ keyId, keySecret })).filter((inv) => supportLevel(inv.info) !== 'unsupported');
      if (inverters.length === 0) throw new Error(this.homey.__('device.noHybrid'));
      // A plain name for everyday use; the model and firmware are in the device settings.
      const name = this.homey.__('device.name');
      return inverters.map((inv) => ({
        name: inverters.length > 1 ? `${name} (${inv.name})` : name,
        data: { id: inv.serialNumber },
        settings: { key_id: keyId, key_secret: keySecret, ...priceSettings },
      }));
    });
  }
}
