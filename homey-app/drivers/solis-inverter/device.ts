import { SolisCloudTransport } from '../../lib/brands/solis/SolisCloudTransport.js';
import { SolisModbusTransport } from '../../lib/brands/solis/SolisModbusTransport.js';
import { solisWorkMode } from '../../lib/brands/solis/storageMode.js';
import { BatteryPlannerDevice, type Connections, num, type Settings } from '../../lib/homey/BatteryPlannerDevice.js';
import { type InverterInfo, type InverterTransport, supportLevel } from '../../lib/inverter/types.js';
import { ModbusTcpClient } from '../../lib/modbus/ModbusTcpClient.js';

/** A Solis hybrid inverter, through SolisCloud or locally over Modbus TCP. */
export default class SolisInverterDevice extends BatteryPlannerDevice {
  protected readonly workMode = solisWorkMode;

  /**
   * The chosen connection, with the other one as fallback when it is set up and wanted. SolisCloud's
   * history database is used for learning whenever a key exists: it does not go through the logger.
   */
  protected connections(s: Settings, serialNumber: string): Connections {
    const cloud = s.key_id && s.key_secret
      ? new SolisCloudTransport({ keyId: String(s.key_id), keySecret: String(s.key_secret) }, serialNumber)
      : null;
    const modbus = s.modbus_host
      ? new SolisModbusTransport(new ModbusTcpClient({
        host: String(s.modbus_host).trim(), port: num(s.modbus_port, 502), unit: num(s.modbus_unit, 1),
      }))
      : null;
    const wantModbus = s.connection_primary === 'modbus';
    const primary = wantModbus ? modbus ?? cloud : cloud ?? modbus;
    if (!primary) throw new Error('Set up SolisCloud or Modbus in the device settings');
    const other = primary === cloud ? modbus : cloud;
    return { primary, fallback: s.connection_fallback !== false ? other : null, history: cloud };
  }

  protected override connectionName(transport: InverterTransport): string {
    return transport.kind === 'local' ? `Modbus (${String(this.getSetting('modbus_host') ?? '').trim()})` : transport.name;
  }

  protected override localLiveIntervalMs(): number {
    return Math.max(15, num(this.getSetting('modbus_interval'), 60)) * 1000;
  }

  /** Modbus only reports a model code: keep the model name and rated power SolisCloud reported. */
  protected override mergeInfo(info: InverterInfo, known: InverterInfo | null): InverterInfo {
    if (known && info.dataLogger === 'Modbus TCP' && known.modelCode.toUpperCase() === info.modelCode) {
      return { ...info, model: known.model, ratedPowerKw: known.ratedPowerKw };
    }
    return info;
  }

  protected override scheduleSlots(info: InverterInfo): number {
    return info.touV2 ? 6 : 3;
  }

  /** The older 3-slot schedule is written through SolisCloud only. */
  protected override canControl(): boolean {
    if (!this.info) return true;
    const level = supportLevel(this.info);
    return level === 'full' || (level === 'basic' && this.transport?.kind === 'cloud');
  }

  protected override cannotControlText(): string {
    return this.homey.__('device.monitorOnly');
  }

  protected override lockWarning(): string {
    return 'Battery locked by a SolisCloud remote command (0 A). Release it in SolisCloud: '
      + 'Quick Control → Discharge with a short duration. The limit returns to normal when it ends.';
  }
}
