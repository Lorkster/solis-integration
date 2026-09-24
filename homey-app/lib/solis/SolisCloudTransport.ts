import type { HistorySample, InverterSettings, InverterSummary, InverterTransport, LiveData, TouSlot } from '../inverter/types.js';
import { utcOffsetHours } from '../time.js';
import { CHARGE_SLOT_CIDS, Cid, DISCHARGE_SLOT_CIDS, SETTINGS_CIDS, type SlotCids, TOU_V2_MARKER } from './cids.js';
import { SolisApiError, SolisCloudClient, type SolisCredentials } from './SolisCloudClient.js';

const BATCH_SIZE = 20;

export async function listInverters(credentials: SolisCredentials): Promise<InverterSummary[]> {
  const records = await new SolisCloudClient(credentials).inverterList();
  return records.map((r) => ({
    serialNumber: String(r.sn),
    name: String(r.stationName ?? r.sn),
    model: String(r.machine ?? r.model ?? 'Solis'),
  }));
}

export class SolisCloudTransport implements InverterTransport {
  readonly kind = 'soliscloud' as const;
  private readonly client: SolisCloudClient;

  constructor(credentials: SolisCredentials, private readonly serialNumber: string, client?: SolisCloudClient) {
    this.client = client ?? new SolisCloudClient(credentials);
  }

  async getLiveData(): Promise<LiveData> {
    return parseLiveData(await this.client.inverterDetail(this.serialNumber));
  }

  async getHistory(date: string, timeZone: string): Promise<HistorySample[]> {
    const noon = new Date(`${date}T12:00:00Z`);
    const records = await this.client.inverterDay(this.serialNumber, date, utcOffsetHours(noon, timeZone));
    return records.map(parseHistorySample).filter((s): s is HistorySample => s !== null);
  }

  async readSettings(): Promise<InverterSettings> {
    const values = new Map<number, string>();
    for (let i = 0; i < SETTINGS_CIDS.length; i += BATCH_SIZE) {
      const batch = await this.client.readBatch(this.serialNumber, SETTINGS_CIDS.slice(i, i + BATCH_SIZE));
      batch.forEach((value, cid) => values.set(cid, value));
    }
    const marker = await this.client.read(this.serialNumber, Cid.touV2Marker);
    const num = (cid: number): number => {
      const value = Number(values.get(cid));
      if (!Number.isFinite(value)) throw new SolisApiError(`CID ${cid} unreadable: ${values.get(cid)}`);
      return value;
    };
    const slot = (cids: SlotCids): TouSlot => {
      const [start = '00:00', end = '00:00'] = (values.get(cids.time) ?? '').split('-');
      return {
        enabled: values.get(cids.switch) === '1',
        start,
        end,
        currentA: num(cids.current),
        soc: num(cids.soc),
      };
    };
    return {
      storageModeRaw: num(Cid.storageMode),
      reserveSoc: num(Cid.reserveSoc),
      overDischargeSoc: num(Cid.overDischargeSoc),
      offGridOverDischargeSoc: num(Cid.offGridOverDischargeSoc),
      forceChargeSoc: num(Cid.forceChargeSoc),
      maxChargeSoc: num(Cid.maxChargeSoc),
      maxChargeCurrentA: num(Cid.maxChargeCurrent),
      maxDischargeCurrentA: num(Cid.maxDischargeCurrent),
      touV2: marker === TOU_V2_MARKER,
      chargeSlots: CHARGE_SLOT_CIDS.map(slot),
      dischargeSlots: DISCHARGE_SLOT_CIDS.map(slot),
    };
  }

  writeStorageMode(raw: number, previous?: number): Promise<void> {
    return this.client.control(this.serialNumber, Cid.storageMode, String(raw), previous?.toString());
  }

  writeReserveSoc(pct: number, previous?: number): Promise<void> {
    return this.client.control(this.serialNumber, Cid.reserveSoc, String(Math.round(pct)), previous?.toString());
  }

  writeChargeSlot(index: number, slot: TouSlot, previous?: TouSlot): Promise<void> {
    return this.writeSlot(CHARGE_SLOT_CIDS[index], slot, previous);
  }

  writeDischargeSlot(index: number, slot: TouSlot, previous?: TouSlot): Promise<void> {
    return this.writeSlot(DISCHARGE_SLOT_CIDS[index], slot, previous);
  }

  /** Writes only the fields that differ. Parameters are written before the enable switch. */
  private async writeSlot(cids: SlotCids, slot: TouSlot, previous?: TouSlot): Promise<void> {
    const sn = this.serialNumber;
    const time = `${slot.start}-${slot.end}`;
    const previousTime = previous ? `${previous.start}-${previous.end}` : undefined;
    if (slot.enabled && previous?.enabled) {
      // Avoid running a half-updated slot: switch it off while changing it.
      if (time !== previousTime || slot.currentA !== previous.currentA || slot.soc !== previous.soc) {
        await this.client.control(sn, cids.switch, '0', '1');
        previous = { ...previous, enabled: false };
      }
    }
    if (time !== previousTime) await this.client.control(sn, cids.time, time, previousTime);
    if (slot.currentA !== previous?.currentA) {
      await this.client.control(sn, cids.current, String(slot.currentA), previous?.currentA.toString());
    }
    if (slot.soc !== previous?.soc) await this.client.control(sn, cids.soc, String(slot.soc), previous?.soc.toString());
    if (slot.enabled !== previous?.enabled) {
      await this.client.control(sn, cids.switch, slot.enabled ? '1' : '0', previous ? (previous.enabled ? '1' : '0') : undefined);
    }
  }
}

const POWER_UNITS: Record<string, number> = { W: 1, kW: 1_000, MW: 1_000_000 };
const ENERGY_UNITS: Record<string, number> = { Wh: 0.001, kWh: 1, MWh: 1_000, GWh: 1_000_000 };

function scaled(detail: Record<string, unknown>, key: string, units: Record<string, number>, fallbackUnit: string): number {
  const value = Number(detail[key]);
  if (!Number.isFinite(value)) return NaN;
  const unit = String(detail[`${key}Str`] ?? fallbackUnit);
  return value * (units[unit] ?? units[fallbackUnit]);
}

/** DC PV power as the sum of voltage × current over all MPPT inputs, or NaN if not reported. */
export function dcPvPowerW(record: Record<string, unknown>): number {
  let total = 0;
  let found = false;
  for (let i = 1; i <= 32; i++) {
    const u = Number(record[`uPv${i}`]);
    const a = Number(record[`iPv${i}`]);
    if (Number.isFinite(u) && Number.isFinite(a)) {
      total += u * a;
      found = true;
    }
  }
  return found ? total : NaN;
}

/** History records carry power in W unless a unit field says otherwise. */
export function parseHistorySample(record: Record<string, unknown>): HistorySample | null {
  const time = new Date(Number(record.dataTimestamp));
  const loadW = scaled(record, 'familyLoadPower', POWER_UNITS, 'W');
  if (Number.isNaN(time.getTime()) || !Number.isFinite(loadW)) return null;
  // History reports pSum in W, positive when exporting; batteryPower in W with a direction flag
  // (assumed 1 = discharging; only charging vs. not charging matters for curtailment detection).
  const pSum = Number(record.pSum ?? 0);
  const batteryAbs = Math.abs(Number(record.batteryPower ?? 0));
  const batteryW = Number(record.currentDirectionBattery) === 1 ? -batteryAbs : batteryAbs;
  return { time, loadW, pvW: dcPvPowerW(record), gridW: -pSum, batteryW };
}

export function parseLiveData(detail: Record<string, unknown>): LiveData {
  const powerW = (key: string) => scaled(detail, key, POWER_UNITS, 'kW');
  const energyKwh = (key: string) => scaled(detail, key, ENERGY_UNITS, 'kWh');

  // batteryPowerZheng / batteryPowerFu are the charge / discharge components in W.
  // batteryDirection: 1 = charging, 2 = discharging, 3 = idle.
  const charging = Number(detail.batteryPowerZheng ?? 0);
  const discharging = Number(detail.batteryPowerFu ?? 0);
  let batteryPowerW: number;
  if (charging > 0) batteryPowerW = charging;
  else if (discharging > 0) batteryPowerW = -discharging;
  else batteryPowerW = powerW('batteryPower') * (Number(detail.batteryDirection) === 2 ? -1 : 1);

  const dcW = dcPvPowerW(detail);
  const pvW = Number.isFinite(dcW) ? dcW : powerW('dcPac');
  return {
    timestamp: new Date(Number(detail.dataTimestamp)),
    socPct: Number(detail.batteryCapacitySoc),
    batteryPowerW,
    pvPowerW: Number.isFinite(pvW) ? pvW : 0,
    gridPowerW: -powerW('psum'), // psum is negative when importing
    loadPowerW: powerW('familyLoadPower'),
    batteryVoltageV: Number(detail.batteryVoltage),
    batteryChargedTotalKwh: energyKwh('batteryTotalChargeEnergy'),
    batteryDischargedTotalKwh: energyKwh('batteryTotalDischargeEnergy'),
    // TODO: identify the field that shows the backup output feeding the house (outage test).
    onBackup: null,
    remoteControlEnabled: detail.batteryCDEnableSet === undefined ? null : Number(detail.batteryCDEnableSet) === 1,
    remoteCurrentLimitA: detail.batteryCDISet === undefined ? null : Number(detail.batteryCDISet),
  };
}
