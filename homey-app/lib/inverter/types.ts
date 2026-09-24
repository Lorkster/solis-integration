/**
 * Transport-independent model of the inverter. The SolisCloud transport maps these onto CIDs;
 * a future local Modbus transport maps the same operations onto registers.
 */

/** One time-of-use slot. Times are inverter-local "HH:MM". Slots repeat every day. */
export interface TouSlot {
  enabled: boolean;
  start: string;
  end: string;
  currentA: number;
  soc: number; // charge slot: target SOC; discharge slot: stop SOC
}

export const DISABLED_SLOT: TouSlot = { enabled: false, start: '00:00', end: '00:00', currentA: 0, soc: 100 };

export interface InverterSettings {
  storageModeRaw: number;
  reserveSoc: number; // "backup SOC", used when the backup/reserve bit is set
  overDischargeSoc: number;
  offGridOverDischargeSoc: number; // battery floor while running on the backup output
  forceChargeSoc: number;
  maxChargeSoc: number;
  maxChargeCurrentA: number;
  maxDischargeCurrentA: number;
  touV2: boolean; // 6+6 slot schedule firmware
  chargeSlots: TouSlot[];
  dischargeSlots: TouSlot[];
}

export interface LiveData {
  timestamp: Date; // when the inverter/logger sampled the data
  socPct: number;
  batteryPowerW: number; // positive = charging
  pvPowerW: number;
  gridPowerW: number; // positive = import
  loadPowerW: number;
  batteryVoltageV: number;
  batteryChargedTotalKwh: number;
  batteryDischargedTotalKwh: number;
  /** Best-effort indication that the house is fed from the inverter's backup output. */
  onBackup: boolean | null;
  /** SolisCloud remote-control current limit (EMS / Quick Control), null if not reported. */
  remoteControlEnabled: boolean | null;
  remoteCurrentLimitA: number | null;
}

export interface InverterSummary {
  serialNumber: string;
  name: string;
  model: string;
}

export interface HistorySample {
  time: Date;
  loadW: number;
  pvW: number;
  gridW: number; // positive = import
  batteryW: number; // positive = charging
}

export interface InverterTransport {
  readonly kind: 'soliscloud' | 'modbus';
  getLiveData(): Promise<LiveData>;
  /** Past load and PV samples for a local day, if the transport can provide history. */
  getHistory?(date: string, timeZone: string): Promise<HistorySample[]>;
  readSettings(): Promise<InverterSettings>;
  writeStorageMode(raw: number, previous?: number): Promise<void>;
  writeReserveSoc(pct: number, previous?: number): Promise<void>;
  writeChargeSlot(index: number, slot: TouSlot, previous?: TouSlot): Promise<void>;
  writeDischargeSlot(index: number, slot: TouSlot, previous?: TouSlot): Promise<void>;
}
