import { SolisCloudTransport } from '../../lib/brands/solis/SolisCloudTransport.js';
import { SolisModbusTransport } from '../../lib/brands/solis/SolisModbusTransport.js';
import { solisWorkMode } from '../../lib/brands/solis/storageMode.js';
import { BatteryPlannerDevice, type Connections, num, type Settings } from '../../lib/homey/BatteryPlannerDevice.js';
import { type InverterInfo, type InverterTransport, supportLevel } from '../../lib/inverter/types.js';
import { ModbusTcpClient } from '../../lib/modbus/ModbusTcpClient.js';

/** How often the max grid charging current is read over Modbus while SolisCloud is the connection (sooner while it blocks charging). */
const GRID_CHARGE_CHECK_MS = 6 * 3_600_000;
const GRID_CHARGE_RECHECK_MS = 30 * 60_000;

/** Remote Dispatch pulse for grid charging that does not start: after how long, how often, how strong. */
const PULSE_AFTER_MIN = 5;
const PULSES_PER_PERIOD = 2;
const PULSE_GAP_MS = 15 * 60_000;
const PULSE_HOLD_MS = 45_000;
const PULSE_CHARGE_W = 1000;

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
    if (cloud && modbus) cloud.gridChargeLimit = this.sparse(() => modbus.readMaxGridChargeCurrent());
    this.modbus = modbus;
    const wantModbus = s.connection_primary === 'modbus';
    const primary = wantModbus ? modbus ?? cloud : cloud ?? modbus;
    if (!primary) throw new Error('Set up SolisCloud or Modbus in the device settings');
    const other = primary === cloud ? modbus : cloud;
    return { primary, fallback: s.connection_fallback !== false ? other : null, history: cloud };
  }

  private gridChargeCache: { value: number | null; at: number } = { value: null, at: 0 };
  private modbus: SolisModbusTransport | null = null;
  /** Pulses sent per charge period (period start → times). */
  private readonly pulses = new Map<number, number[]>();

  /**
   * Time-of-use slots on this firmware can stop charging from the grid until a Remote Dispatch
   * command has run (26 Sep 2026). When a planned grid charge has not started for a few minutes,
   * send the short command Quick Control would send, at most twice per period, 15 minutes apart.
   */
  protected override async onGridChargeStalled(minutes: number, periodStart: Date): Promise<void> {
    const modbus = this.modbus;
    if (!modbus || this.getSetting('grid_charge_pulse') === false || this.controlMode !== 'auto') return;
    if (minutes < PULSE_AFTER_MIN) return;
    const now = Date.now();
    for (const [start] of this.pulses) if (now - start > 86_400_000) this.pulses.delete(start);
    const sent = this.pulses.get(periodStart.getTime()) ?? [];
    if (sent.length >= PULSES_PER_PERIOD || (sent.length > 0 && now - sent[sent.length - 1] < PULSE_GAP_MS)) return;
    this.pulses.set(periodStart.getTime(), [...sent, now]);
    this.log(`Planned grid charging has not started for ${Math.round(minutes)} min: Remote Dispatch pulse ${sent.length + 1}`);
    this.inverterBusy = true;
    try {
      await modbus.pulseRemoteDispatch(PULSE_CHARGE_W, PULSE_HOLD_MS, (ms) => new Promise((resolve) => this.homey.setTimeout(resolve, ms)));
      this.log('Remote Dispatch pulse done');
    } catch (err) {
      this.error('Remote Dispatch pulse failed:', err);
    } finally {
      this.inverterBusy = false;
    }
  }

  /**
   * One Modbus read every few hours, kept across reconnects: polling Modbus often makes SolisCloud
   * commands fail (B0173), a single read between the app's commands does not.
   */
  private sparse(read: () => Promise<number>): () => Promise<number | null> {
    return async () => {
      const every = this.gridChargeCache.value === 0 ? GRID_CHARGE_RECHECK_MS : GRID_CHARGE_CHECK_MS;
      if (Date.now() - this.gridChargeCache.at >= every) {
        this.gridChargeCache = { value: await read().catch(() => this.gridChargeCache.value), at: Date.now() };
      }
      return this.gridChargeCache.value;
    };
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
