import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FailoverTransport } from '../lib/inverter/FailoverTransport.js';
import type { InverterTransport, LiveData } from '../lib/inverter/types.js';
import type { ModbusConnector, ModbusSession } from '../lib/modbus/ModbusTcpClient.js';
import { parseModbusLive, Reg, SolisModbusTransport } from '../lib/modbus/SolisModbusTransport.js';

/** In-memory inverter registers behind a fake logger. */
class FakeInverter implements ModbusConnector, ModbusSession {
  input = new Map<number, number>();
  holding = new Map<number, number>();
  writes: Array<[number, number[]]> = [];

  async session<T>(work: (s: ModbusSession) => Promise<T>): Promise<T> {
    return work(this);
  }

  async readInput(start: number, count: number): Promise<number[]> {
    return Array.from({ length: count }, (_, i) => this.input.get(start + i) ?? 0);
  }

  async readHolding(start: number, count: number): Promise<number[]> {
    return Array.from({ length: count }, (_, i) => this.holding.get(start + i) ?? 0);
  }

  async writeSingle(register: number, value: number): Promise<void> {
    this.writes.push([register, [value]]);
    this.holding.set(register, value);
  }

  async writeMultiple(start: number, values: number[]): Promise<void> {
    this.writes.push([start, values]);
    values.forEach((v, i) => this.holding.set(start + i, v));
  }
}

describe('Solis over Modbus', () => {
  it('reads live values like SolisCloud (24 Sep 23:53 probe)', () => {
    const live = parseModbusLive({
      pv: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      grid: [2278, 2279, 2279],
      bat: [4201, 0, 0, 0, 0, 0, 25],
      loads: [3048, 0, 0, 0, 0xffff, 0xffce],
      energy: [0, 5224, 0, 0, 0, 4969],
      meter: [0xffff, 0xf3cf], // −3121 W: importing
    }, new Date('2026-09-24T23:53:00+02:00'));
    assert.equal(live.socPct, 25);
    assert.equal(live.gridPowerW, 3121, 'import is positive in the app');
    assert.equal(live.loadPowerW, 3048);
    assert.equal(live.batteryChargedTotalKwh, 5224);
    assert.equal(live.gridLost, false);
    assert.ok(Number.isNaN(live.pvTotalKwh), 'totals unknown when not read');
  });

  it('reads lifetime totals for Homey Energy', () => {
    const live = parseModbusLive({
      pv: Array(10).fill(0), grid: [2300, 2300, 2300], bat: [4200, 0, 0, 0, 0, 0, 50], loads: [1000, 0, 0, 0, 0, 0],
      energy: [0, 0, 0, 0, 0, 0], meter: [0, 0],
      totals: [0, 8556, 0, 20421, 0, 0, 0, 2497], // PV 8 556 kWh, bought 20 421, sold 2 497
    }, new Date());
    assert.deepEqual([live.pvTotalKwh, live.gridImportTotalKwh, live.gridExportTotalKwh], [8556, 20421, 2497]);
  });

  it('reads the schedule and switches from the shared bit register', async () => {
    const inv = new FakeInverter();
    inv.holding.set(Reg.slotSwitches, 0b1); // charge slot 1 on
    [99, 150, 0, 12, 15, 14, 45].forEach((v, i) => inv.holding.set(Reg.chargeSlots + i, v));
    inv.holding.set(Reg.exportFlags, 80);
    inv.holding.set(Reg.storageMode, 51);
    const settings = await new SolisModbusTransport(inv).readSettings();
    assert.deepEqual(settings.chargeSlots[0], { enabled: true, start: '12:15', end: '14:45', currentA: 15, soc: 99 });
    assert.equal(settings.chargeSlots[1].enabled, false);
    assert.equal(settings.exportAllowed, true);
    assert.equal(settings.storageModeRaw, 51);
  });

  it('writes a slot switched off first, keeps the cut-off voltage and other slots, then switches it on', async () => {
    const inv = new FakeInverter();
    inv.holding.set(Reg.slotSwitches, 0b100001); // slots 1 and 6 on
    [80, 160, 4200, 2, 0, 4, 0].forEach((v, i) => inv.holding.set(Reg.chargeSlots + i, v));
    await new SolisModbusTransport(inv).writeChargeSlot(0, { enabled: true, start: '13:45', end: '15:30', currentA: 16, soc: 84 });
    assert.deepEqual(await inv.readHolding(Reg.chargeSlots, 7), [84, 160, 4200, 13, 45, 15, 30]);
    assert.equal(inv.holding.get(Reg.slotSwitches), 0b100001, 'both slots on again');
    assert.deepEqual(inv.writes[0], [Reg.slotSwitches, [0b100000]], 'slot 1 switched off before changing it');
  });

  it('switches export with bit 3 of register 43483 (set = blocked)', async () => {
    const inv = new FakeInverter();
    inv.holding.set(Reg.exportFlags, 88); // blocked, as found on 24 Sep
    const t = new SolisModbusTransport(inv);
    await t.writeExportAllowed(true);
    assert.equal(inv.holding.get(Reg.exportFlags), 80);
    await t.writeExportAllowed(false);
    assert.equal(inv.holding.get(Reg.exportFlags), 88);
  });

  it('reads the serial number', async () => {
    const inv = new FakeInverter();
    const text = 'ABC1234567890XYZ';
    for (let i = 0; i < 8; i++) inv.input.set(Reg.serial + i, text.charCodeAt(2 * i) * 256 + text.charCodeAt(2 * i + 1));
    assert.equal(await new SolisModbusTransport(inv).getSerialNumber(), text);
  });
});

describe('failover', () => {
  const transport = (kind: 'soliscloud' | 'modbus', fails: () => boolean): InverterTransport => ({
    kind,
    getInfo: async () => { throw new Error('n/a'); },
    getLiveData: async () => {
      if (fails()) throw new Error(`${kind} down`);
      return { socPct: kind === 'modbus' ? 1 : 2 } as LiveData;
    },
    readSettings: async () => { throw new Error('n/a'); },
    writeStorageMode: async () => undefined,
    writeReserveSoc: async () => undefined,
    writeChargeSlot: async () => undefined,
    writeDischargeSlot: async () => undefined,
  });

  it('uses one connection at a time, falls back after three failures and retries the primary later', async () => {
    let modbusDown = true;
    let clock = 0;
    const switches: string[] = [];
    const f = new FailoverTransport(transport('modbus', () => modbusDown), transport('soliscloud', () => false), null,
      (active) => switches.push(active.kind), 3, 30 * 60_000, () => clock);
    for (let i = 0; i < 3; i++) await assert.rejects(f.getLiveData());
    assert.equal(f.kind, 'soliscloud');
    assert.equal((await f.getLiveData()).socPct, 2);
    modbusDown = false;
    clock += 31 * 60_000;
    assert.equal((await f.getLiveData()).socPct, 1, 'back on Modbus');
    assert.deepEqual(switches, ['soliscloud', 'modbus']);
  });

  it('switches when commands fail although live data still arrives, and resends the failed command', async () => {
    const writes: string[] = [];
    const cloud: InverterTransport = {
      ...transport('soliscloud', () => false),
      writeReserveSoc: async () => { throw new Error('Sending failure, the current datalogger is offline'); },
    };
    const modbus: InverterTransport = { ...transport('modbus', () => false), writeReserveSoc: async (pct) => { writes.push(`modbus ${pct}`); } };
    const switches: string[] = [];
    const f = new FailoverTransport(cloud, modbus, null, (active) => switches.push(active.kind));
    await assert.rejects(f.writeReserveSoc(30));
    await f.getLiveData(); // live data keeps working: does not reset the command count
    await f.writeReserveSoc(30);
    assert.deepEqual(writes, ['modbus 30'], 'sent through Modbus right after the second failure');
    assert.deepEqual(switches, ['modbus']);
    assert.equal(f.kind, 'modbus');
  });

  it('stays on the primary without a fallback', async () => {
    const f = new FailoverTransport(transport('modbus', () => true), null, null);
    for (let i = 0; i < 5; i++) await assert.rejects(f.getLiveData());
    assert.equal(f.kind, 'modbus');
  });
});
