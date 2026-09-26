import { gridLost } from '../../inverter/PowerCut.js';
import type { InverterInfo, InverterSettings, InverterTransport, LiveData, TouSlot } from '../../inverter/types.js';
import { type ModbusConnector, ModbusError, type ModbusSession } from '../../modbus/ModbusTcpClient.js';

/**
 * Solis hybrid inverter over Modbus TCP (S2-WL-ST logger or an RS485 gateway). Register map as in
 * github.com/Pho3niX90/solis_modbus, checked against SolisCloud on an S6-EH3P20K-H (25 Sep 2026):
 * the same serial number, slot times, slot currents, storage mode, reserve and export flag.
 */
export const Reg = {
  // Input registers (function 04)
  model: 33000, // product model code, hex
  dsp: 33001,
  hmi: 33002,
  serial: 33004, // 16 registers of ASCII
  pv: 33049, // PV1..4 voltage/current (0.1 V / 0.1 A), then total PV power (u32 W) at 33057
  gridVoltage: 33073, // phase A..C, 0.1 V
  gridFrequency: 33094, // 0.01 Hz
  battery: 33133, // voltage 0.1 V, current 0.1 A, direction (0 charge / 1 discharge) ... SOC at 33139
  loads: 33147, // house load W, backup load W, battery power u32 W, grid port power s32 W
  batteryEnergy: 33161, // total charged u32 kWh (33161-2), total discharged (33165-6)
  pvTotal: 33029, // lifetime PV generation u32 kWh
  gridTotals: 33169, // lifetime imported u32 kWh (33169-70), exported (33173-74)
  meterPower: 33263, // grid meter active power s32 W, negative while importing
  // Holding registers (function 03 / 06 / 16)
  maxSoc: 43010,
  overDischargeSoc: 43011,
  forceChargeSoc: 43018,
  reserveSoc: 43024, // "Backup SOC"
  storageMode: 43110, // same bits as SolisCloud CID 636
  maxChargeCurrent: 43117, // 0.1 A
  maxDischargeCurrent: 43118,
  offGridOverDischargeSoc: 43137,
  maxGridChargeCurrent: 43342, // 0.1 A; 0 blocks grid charging in the time slots (factory default 80 A)
  exportFlags: 43483, // bit 3 set = export blocked
  dispatchSwitch: 44100, // Remote Dispatch on/off, then the failsafe in minutes (44101)
  dispatchControl: 44105, // real-time control: mode, power (S32, 10 W), function switches (44108)
  slotSwitches: 43707, // charge slots 1-6 = bits 0-5, discharge slots 1-6 = bits 6-11
  chargeSlots: 43708, // 7 registers per slot: SOC, current (0.1 A), cut-off voltage, start h, start m, end h, end m
  dischargeSlots: 43750,
} as const;

const SLOT_REGS = 7;
/** 44108 as Quick Control sets it: PV shutdown off, DO off, grid charging allowed, off-grid standby off (01 in each pair). */
const DISPATCH_FLAGS = 0x5555;
const EXPORT_BLOCKED_BIT = 1 << 3;

const u32 = (hi: number, lo: number) => hi * 0x10000 + lo;
const s32 = (hi: number, lo: number) => {
  const v = u32(hi, lo);
  return v >= 0x80000000 ? v - 0x100000000 : v;
};
const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

export function decodeSlot(regs: number[], enabled: boolean): TouSlot {
  const [soc, current, , sh, sm, eh, em] = regs;
  return { enabled, start: hhmm(sh, sm), end: hhmm(eh, em), currentA: Math.round(current / 10), soc };
}

/** Slot registers to write, keeping the cut-off voltage the inverter has. */
export function encodeSlot(slot: TouSlot, current: number[]): number[] {
  const [sh, sm] = slot.start.split(':').map(Number);
  const [eh, em] = slot.end.split(':').map(Number);
  return [Math.round(slot.soc), Math.round(slot.currentA * 10), current[2] ?? 0, sh, sm, eh, em];
}

export class SolisModbusTransport implements InverterTransport {
  readonly kind = 'local' as const;
  readonly name = 'Modbus';
  /** False when getInfo found no 6+6 slot registers: schedule writes are refused (SolisCloud handles those). */
  private touV2: boolean | null = null;

  constructor(private readonly modbus: ModbusConnector) {}

  getInfo(): Promise<InverterInfo> {
    return this.modbus.session(async (m) => {
      const [model, dsp, hmi] = await m.readInput(Reg.model, 3);
      const soc = await m.readInput(Reg.battery + 6, 1).then(() => true).catch(() => false);
      // The 6-slot schedule registers only exist on TOU v2 firmware.
      const touV2 = await m.readHolding(Reg.slotSwitches, 8).then(() => true).catch(() => false);
      this.touV2 = touV2;
      const hex = (v: number) => v.toString(16).toUpperCase().padStart(4, '0');
      return {
        model: `Solis ${hex(model)}`,
        modelCode: hex(model),
        ratedPowerKw: null,
        firmware: `HMI ${hex(hmi)} · DSP ${hex(dsp)}`,
        dataLogger: 'Modbus TCP',
        hybrid: soc,
        touV2,
      };
    });
  }

  /**
   * A short Remote Dispatch command, as SolisCloud's Quick Control → Charge sends it: charge with
   * grid charging allowed, a failsafe that ends it after a minute whatever happens, then off again.
   * On an S6-EH3P20K-H, time-of-use slots did not charge from the grid until such a command had run
   * (26 Sep 2026); afterwards the active slot charged at its own current.
   */
  async pulseRemoteDispatch(chargeW: number, holdMs: number, wait: (ms: number) => Promise<void>): Promise<void> {
    const power = Math.max(1, Math.round(chargeW / 10));
    await this.modbus.session(async (m) => {
      await m.writeMultiple(Reg.dispatchControl, [2, (power >> 16) & 0xffff, power & 0xffff, DISPATCH_FLAGS]);
      await m.writeMultiple(Reg.dispatchSwitch, [1, 1]);
    });
    try {
      await wait(holdMs);
    } finally {
      await this.modbus.session(async (m) => {
        await m.writeMultiple(Reg.dispatchSwitch, [0]);
        const [on] = await m.readHolding(Reg.dispatchSwitch, 1);
        if (on !== 0) throw new ModbusError('Remote Dispatch still on; its 1-minute failsafe ends it');
      });
    }
  }

  /** Max grid charging current in A (register 43342), which SolisCloud cannot read on hybrids. */
  readMaxGridChargeCurrent(): Promise<number> {
    return this.modbus.session(async (m) => (await m.readHolding(Reg.maxGridChargeCurrent, 1))[0] / 10);
  }

  /** Inverter serial number (the same id SolisCloud uses). */
  getSerialNumber(): Promise<string> {
    return this.modbus.session(async (m) => {
      const regs = await m.readInput(Reg.serial, 16);
      return Buffer.from(regs.flatMap((r) => [r >> 8, r & 0xff])).toString('ascii').replace(/[\0\r\n ]+/g, '');
    });
  }

  getLiveData(): Promise<LiveData> {
    return this.modbus.session(async (m) => {
      const pv = await m.readInput(Reg.pv, 10);
      const grid = await m.readInput(Reg.gridVoltage, 3);
      const bat = await m.readInput(Reg.battery, 7);
      const loads = await m.readInput(Reg.loads, 6);
      const energy = await m.readInput(Reg.batteryEnergy, 6);
      const meter = await m.readInput(Reg.meterPower, 2);
      const totals = [...await m.readInput(Reg.pvTotal, 2), ...await m.readInput(Reg.gridTotals, 6)];
      return parseModbusLive({ pv, grid, bat, loads, energy, meter, totals }, new Date());
    });
  }

  readSettings(): Promise<InverterSettings> {
    return this.modbus.session(async (m) => {
      const charge = await m.readHolding(Reg.slotSwitches, 1 + 6 * SLOT_REGS);
      const discharge = await m.readHolding(Reg.dischargeSlots, 6 * SLOT_REGS);
      const one = async (reg: number) => (await m.readHolding(reg, 1))[0];
      const switches = charge[0];
      const slots = (regs: number[], offset: number, bitBase: number) => Array.from({ length: 6 }, (_, i) =>
        decodeSlot(regs.slice(offset + i * SLOT_REGS, offset + (i + 1) * SLOT_REGS), Boolean(switches & (1 << (bitBase + i)))));
      const exportFlags = await one(Reg.exportFlags);
      const [maxCharge, maxDischarge] = await m.readHolding(Reg.maxChargeCurrent, 2);
      const gridCharge = await one(Reg.maxGridChargeCurrent).catch(() => null);
      return {
        storageModeRaw: await one(Reg.storageMode),
        reserveSoc: await one(Reg.reserveSoc),
        overDischargeSoc: await one(Reg.overDischargeSoc),
        offGridOverDischargeSoc: await one(Reg.offGridOverDischargeSoc),
        forceChargeSoc: await one(Reg.forceChargeSoc),
        maxChargeSoc: await one(Reg.maxSoc),
        maxChargeCurrentA: maxCharge / 10,
        maxDischargeCurrentA: maxDischarge / 10,
        touV2: true,
        exportAllowed: (exportFlags & EXPORT_BLOCKED_BIT) === 0,
        exportLimitW: null,
        maxGridChargeCurrentA: gridCharge === null ? null : gridCharge / 10,
        chargeSlots: slots(charge, 1, 0),
        dischargeSlots: slots(discharge, 0, 6),
      };
    });
  }

  writeStorageMode(raw: number): Promise<void> {
    return this.modbus.session((m) => writeChecked(m, Reg.storageMode, raw));
  }

  writeReserveSoc(pct: number): Promise<void> {
    return this.modbus.session((m) => writeChecked(m, Reg.reserveSoc, Math.round(pct)));
  }

  writeChargeSlot(index: number, slot: TouSlot): Promise<void> {
    return this.writeSlot(Reg.chargeSlots + index * SLOT_REGS, index, slot);
  }

  writeDischargeSlot(index: number, slot: TouSlot): Promise<void> {
    return this.writeSlot(Reg.dischargeSlots + index * SLOT_REGS, 6 + index, slot);
  }

  writeExportAllowed(allowed: boolean): Promise<void> {
    return this.modbus.session(async (m) => {
      const [flags] = await m.readHolding(Reg.exportFlags, 1);
      const next = allowed ? flags & ~EXPORT_BLOCKED_BIT : flags | EXPORT_BLOCKED_BIT;
      if (next !== flags) await writeChecked(m, Reg.exportFlags, next);
    });
  }

  /**
   * Switches the slot off while changing it (so a half-written slot never runs), writes its seven
   * registers in one go, then sets the switch bit. Every write is read back.
   */
  private writeSlot(base: number, bit: number, slot: TouSlot): Promise<void> {
    if (this.touV2 === false) return Promise.reject(new ModbusError('The 3-slot schedule is only supported through SolisCloud'));
    return this.modbus.session(async (m) => {
      const [switches] = await m.readHolding(Reg.slotSwitches, 1);
      const current = await m.readHolding(base, SLOT_REGS);
      const wanted = encodeSlot(slot, current);
      const changed = wanted.some((v, i) => v !== current[i]);
      const on = Boolean(switches & (1 << bit));
      if (changed) {
        if (on) await writeChecked(m, Reg.slotSwitches, switches & ~(1 << bit));
        await m.writeMultiple(base, wanted);
        const back = await m.readHolding(base, SLOT_REGS);
        if (back.some((v, i) => v !== wanted[i])) throw new ModbusError(`Slot at ${base} reads back ${back.join(',')}, wrote ${wanted.join(',')}`);
      }
      const [now] = await m.readHolding(Reg.slotSwitches, 1);
      const target = slot.enabled ? now | (1 << bit) : now & ~(1 << bit);
      if (target !== now) await writeChecked(m, Reg.slotSwitches, target);
    });
  }
}

async function writeChecked(m: ModbusSession, register: number, value: number): Promise<void> {
  await m.writeSingle(register, value);
  const [back] = await m.readHolding(register, 1);
  if (back !== value) throw new ModbusError(`Register ${register} reads back ${back}, wrote ${value}`);
}

export interface ModbusLiveRegisters {
  pv: number[]; // 33049-33058
  grid: number[]; // 33073-33075
  bat: number[]; // 33133-33139
  loads: number[]; // 33147-33152
  energy: number[]; // 33161-33166
  meter: number[]; // 33263-33264
  totals?: number[]; // 33029-33030, then 33169-33174
}

export function parseModbusLive(r: ModbusLiveRegisters, time: Date): LiveData {
  const batteryW = u32(r.loads[2], r.loads[3]);
  const discharging = r.bat[2] === 1;
  const volts = r.grid.map((v) => v / 10);
  return {
    timestamp: time,
    socPct: r.bat[6],
    batteryPowerW: discharging ? -batteryW : batteryW,
    pvPowerW: u32(r.pv[8], r.pv[9]),
    gridPowerW: -s32(r.meter[0], r.meter[1]), // meter is negative while importing
    loadPowerW: r.loads[0],
    batteryVoltageV: r.bat[0] / 10,
    batteryChargedTotalKwh: u32(r.energy[0], r.energy[1]),
    batteryDischargedTotalKwh: u32(r.energy[4], r.energy[5]),
    pvTotalKwh: r.totals ? u32(r.totals[0], r.totals[1]) : NaN,
    gridImportTotalKwh: r.totals ? u32(r.totals[2], r.totals[3]) : NaN,
    gridExportTotalKwh: r.totals ? u32(r.totals[6], r.totals[7]) : NaN,
    gridLost: gridLost({ uAc1: volts[0], uAc2: volts[1], uAc3: volts[2] }),
    backupLoadW: r.loads[1],
    remoteControlEnabled: null, // SolisCloud's remote limit is not visible over Modbus
    remoteCurrentLimitA: null,
  };
}
