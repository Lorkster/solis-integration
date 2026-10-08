/**
 * Brand-independent model of a hybrid inverter with a time-of-use schedule. Each brand maps these
 * operations onto its own interface: Solis onto SolisCloud CIDs or Modbus registers
 * (lib/brands/solis). The planner, the controller and the Homey devices only use this model.
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
  /** The brand's work-mode setting as a raw value; only the brand's WorkMode interprets it. */
  storageModeRaw: number;
  reserveSoc: number; // "backup SOC", used when the backup/reserve bit is set
  overDischargeSoc: number;
  offGridOverDischargeSoc: number; // battery floor while running on the backup output
  forceChargeSoc: number;
  maxChargeSoc: number;
  maxChargeCurrentA: number;
  maxDischargeCurrentA: number;
  touV2: boolean; // 6+6 slot schedule firmware
  exportAllowed?: boolean | null; // null = not reported
  exportLimitW?: number | null;
  /** Largest current the inverter may take from the grid for charging; 0 blocks grid charging in the schedule. null = not reported. */
  maxGridChargeCurrentA?: number | null;
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
  /** Lifetime totals for Homey Energy (NaN when not reported). */
  pvTotalKwh: number;
  gridImportTotalKwh: number;
  gridExportTotalKwh: number;
  /** True when the grid is missing (power cut), null when the data cannot tell. */
  gridLost: boolean | null;
  /** Load on the inverter's backup output (W). */
  backupLoadW: number;
  /** SolisCloud remote-control current limit (EMS / Quick Control), null if not reported. */
  remoteControlEnabled: boolean | null;
  remoteCurrentLimitA: number | null;
  /**
   * Settings the connection reports along with its live data, at no extra cost to the inverter
   * (e.g. SolisCloud's database). Lets the app notice outside changes without reading the settings.
   */
  reportedSettings?: ReportedSettings | null;
  /** A fault or alarm the connection reports; null when there is none (or it cannot tell). */
  alarm?: string | null;
  /** What the battery's own management system reports through the inverter; null when not reported. */
  bms?: BmsData | null;
}

/**
 * The battery management system's (BMS) values as the inverter passes them on. The limits are what
 * the battery accepts right now: they fall near full or empty and when the cells are cold.
 */
export interface BmsData {
  /** State of health: capacity left compared with new (%). */
  sohPct: number;
  chargeLimitA: number;
  dischargeLimitA: number;
  /** The BMS's fault words as reported; all 0 when there is no fault. */
  faults: number[];
}

/**
 * A command for the inverter's direct control (Solis: Remote Dispatch), which steers the battery
 * from RAM instead of through the stored time-of-use schedule.
 */
export type DirectCommand =
  | { kind: 'off' } // the inverter's own mode (self-use)
  | { kind: 'hold' } // neither charge nor discharge
  | { kind: 'charge'; powerW: number; targetSoc: number }; // from the grid (and solar) up to targetSoc

/** Direct control of the battery, when the brand and connection offer it. */
export interface DirectControl {
  /**
   * Carries out the command until another one replaces it. Without a new write within
   * failsafeMin minutes the inverter ends it by itself. Throws when the inverter does not confirm it.
   */
  writeDirect(command: DirectCommand, failsafeMin: number): Promise<void>;
}

/** Inverter settings as reported with live data; a field is missing when not reported. */
export interface ReportedSettings {
  storageModeRaw?: number;
  /** Bits of storageModeRaw the report covers (Solis: all but time-of-use). */
  storageModeMask?: number;
  overDischargeSoc?: number;
  forceChargeSoc?: number;
}

export interface InverterSummary {
  serialNumber: string;
  name: string;
  model: string;
}

/** What the inverter is, as reported by the cloud or the inverter itself. */
export interface InverterInfo {
  model: string; // e.g. "S6-EH3P20K-H"
  modelCode: string; // the manufacturer's model code, e.g. Solis "3316"
  ratedPowerKw: number | null;
  firmware: string; // e.g. "HMI 1262 · DSP 0945"
  dataLogger: string; // logger or gateway, e.g. "WL" (Solis S2-WL-ST)
  hybrid: boolean; // has battery storage control
  touV2: boolean; // schedule with a target level per slot (Solis: 6+6 time-slot firmware)
}

/**
 * - full: the app can plan and control the battery.
 * - basic: a simpler schedule without a target level per slot (Solis: the older 3-slot schedule).
 * - unsupported: no battery control at all (string inverter).
 */
export type SupportLevel = 'full' | 'basic' | 'unsupported';

export function supportLevel(info: InverterInfo): SupportLevel {
  if (!info.hybrid) return 'unsupported';
  return info.touV2 ? 'full' : 'basic';
}

export interface HistorySample {
  time: Date;
  loadW: number;
  pvW: number;
  gridW: number; // positive = import
  batteryW: number; // positive = charging
}

/**
 * How a brand's work-mode setting changes when the app takes control and when it hands control
 * back. Brands without such a setting use NO_WORK_MODE.
 */
export interface WorkMode {
  /** The mode while the app controls the battery through the schedule. */
  controlled(raw: number, reserveEnabled: boolean): number;
  /** The mode after handing control back: the inverter's own self-use without the app's schedule. */
  released(raw: number): number;
  /** For the log. */
  describe(raw: number): string;
}

export const NO_WORK_MODE: WorkMode = {
  controlled: (raw) => raw,
  released: (raw) => raw,
  describe: (raw) => String(raw),
};

export interface InverterTransport {
  /** Through the manufacturer's cloud, or directly on the local network. */
  readonly kind: 'cloud' | 'local';
  /** Shown to the user, e.g. "SolisCloud" or "Modbus". */
  readonly name: string;
  getInfo(): Promise<InverterInfo>;
  getLiveData(): Promise<LiveData>;
  /** Past load and PV samples for a local day, if the transport can provide history. */
  getHistory?(date: string, timeZone: string): Promise<HistorySample[]>;
  readSettings(): Promise<InverterSettings>;
  writeStorageMode(raw: number, previous?: number): Promise<void>;
  writeReserveSoc(pct: number, previous?: number): Promise<void>;
  writeChargeSlot(index: number, slot: TouSlot, previous?: TouSlot): Promise<void>;
  writeDischargeSlot(index: number, slot: TouSlot, previous?: TouSlot): Promise<void>;
  writeExportAllowed?(allowed: boolean, previous: boolean): Promise<void>;
}
