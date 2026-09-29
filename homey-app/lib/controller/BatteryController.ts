import {
  DISABLED_SLOT, type InverterSettings, type InverterTransport, type LiveData, NO_WORK_MODE, type ReportedSettings, type TouSlot, type WorkMode,
} from '../inverter/types.js';
import { type BatteryAction, planBattery, type PlanInterval, type PlanResult } from '../planner/planner.js';
import { planToSchedule, type Schedule } from '../planner/schedule.js';
import { NO_POWER_TARIFF, peakWeight, type PowerTariffConfig } from '../energy/PowerTariff.js';
import type { PriceArea, PriceProvider, SpotPrice } from '../prices/PriceProvider.js';
import { buyPrice, sellPrice, type TariffConfig } from '../tariff.js';
import { addDays, localDate, localHHMM, localParts } from '../time.js';

export interface ControllerConfig {
  timeZone: string;
  priceArea: PriceArea;
  tariff: TariffConfig;
  capacityKwh: number;
  maxChargeKw: number;
  maxDischargeKw: number;
  /** Grid import limit for charging (house plus charge), 0 or undefined = none. */
  maxImportKw?: number;
  roundTripEfficiency: number;
  cyclingCostPerKwh: number;
  minGainPerKwh: number;
  reserveSocSummer: number;
  reserveSocWinter: number; // November–March
  maxSocPct: number;
  avgLoadKw: number;
  pvTrust: number; // 0..1, share of the PV forecast the plan relies on
  powerTariff?: PowerTariffConfig;
}

export interface Override {
  action: Exclude<BatteryAction, 'self_use'>;
  from: Date;
  until: Date;
}

export interface OutagePreparation {
  targetSoc: number;
  until: Date;
}

export interface PlanState {
  generatedAt: Date;
  reserveSoc: number;
  plan: PlanResult;
  schedule: Schedule;
  pricesUntil: Date;
  /** Periods where selling costs money (export price below zero). */
  negativeExport: Array<{ start: Date; end: Date }>;
}

/**
 * Settings the app wrote itself are known without asking the inverter. They are read again after
 * this long, to notice changes made elsewhere (e.g. in the SolisCloud app); every read goes through
 * the data logger to the inverter.
 */
export const SETTINGS_MAX_AGE_MS = 6 * 3_600_000;
/** The same when the connection reports the main settings with its live data (changes show there). */
export const SETTINGS_MAX_AGE_REPORTED_MS = 24 * 3_600_000;

/** What the controller knows about the inverter's settings, kept across restarts. */
export interface KnownSettings {
  read: InverterSettings | null;
  readAt: number;
  applied: InverterSettings | null;
  writtenAt?: number;
}

/** Charge slots of the schedule format: 6 (TOU v2 firmware) or 3 (older firmware). */
const slotsFor = (settings: InverterSettings) => settings.chargeSlots.length;

export class BatteryController {
  overrides: Override[] = [];
  outage: OutagePreparation | null = null;
  /** Expected house load in kW at a time, e.g. from a learned profile; null = use the average. */
  loadForecast: (time: Date) => number | null = () => null;
  /** Expected PV power in kW at a time; null = unknown (treated as no PV). */
  pvForecast: (time: Date) => number | null = () => null;
  /** Weighted import level (kW) above which the month's power fee rises; 0 = unknown. */
  peakThresholdKw: () => number = () => 0;
  /** Block export while the export price is negative (Automatic mode with the setting on). */
  exportControl = false;
  /** True while export is switched off by the app (not by the user). Kept across restarts by the device. */
  exportBlockedByApp = false;
  /** Settings as last read from the inverter. */
  lastRead: InverterSettings | null = null;
  /** Charge slots the inverter has (6, or 3 on older firmware); follows the settings last read. */
  slotCount = 6;
  /** True when the last apply found settings changed outside the app since the app wrote them. */
  externalChange = false;
  /** How the brand's work mode changes when the app takes or hands back control. */
  workMode: WorkMode = NO_WORK_MODE;
  /**
   * Direct control (Remote Dispatch) carries out the plan: the time-of-use slots stay switched off,
   * so the inverter runs plain self-use whenever direct control ends.
   */
  directMode = false;
  /** When the settings were last read from the inverter (ms since epoch). */
  lastReadAt = 0;
  /** When the app last wrote a setting (ms since epoch); live reports from before then are out of date. */
  lastWriteAt = 0;
  /** How long settings the app knows are trusted before they are read again. */
  settingsMaxAgeMs = SETTINGS_MAX_AGE_MS;
  private lastApplied: InverterSettings | null = null;

  constructor(
    private readonly transport: InverterTransport,
    private readonly prices: PriceProvider,
    public config: ControllerConfig,
    private readonly log: (...args: unknown[]) => void = () => undefined,
  ) {}

  reserveSocAt(now: Date): number {
    const { month } = localParts(now, this.config.timeZone);
    const seasonal = month >= 11 || month <= 3 ? this.config.reserveSocWinter : this.config.reserveSocSummer;
    if (this.outage && this.outage.until > now) return Math.max(seasonal, this.outage.targetSoc);
    return seasonal;
  }

  /** Fetches prices for today and (when published) tomorrow and computes a fresh plan. */
  /**
   * @param running What the inverter carries out now (the previous plan's action), so that a
   *   running charge or hold continues unless changing pays more than the switch costs. Without it,
   *   a near tie could stop a running charge and rewrite the slots for nothing (27 Sep 12:57).
   */
  async buildPlan(live: LiveData, now: Date, running?: BatteryAction | null): Promise<PlanState> {
    this.overrides = this.overrides.filter((o) => o.until > now);
    if (this.outage && this.outage.until <= now) this.outage = null;

    const spot = await this.loadPrices(now);
    const quarterStart = new Date(Math.floor(now.getTime() / 900_000) * 900_000);
    const upcoming = spot.filter((p) => p.end > quarterStart);
    if (upcoming.length === 0) throw new Error('No price data available');

    const tariff = this.config.powerTariff ?? NO_POWER_TARIFF;
    const negativeExport: Array<{ start: Date; end: Date }> = [];
    for (const p of upcoming) {
      if (sellPrice(p.perKwh, this.config.tariff) >= 0) continue;
      const last = negativeExport[negativeExport.length - 1];
      if (last && last.end.getTime() === p.start.getTime()) last.end = p.end;
      else negativeExport.push({ start: p.start, end: p.end });
    }
    const intervals: PlanInterval[] = upcoming.map((p) => ({
      start: p.start,
      end: p.end,
      buy: buyPrice(p.perKwh, p.start, this.config.timeZone, this.config.tariff),
      // With export blocked at negative prices, surplus is throttled instead of sold at a loss.
      sell: this.exportControl ? Math.max(0, sellPrice(p.perKwh, this.config.tariff)) : sellPrice(p.perKwh, this.config.tariff),
      loadKw: this.loadForecast(p.start) ?? this.config.avgLoadKw,
      pvKw: (this.pvForecast(p.start) ?? 0) * this.config.pvTrust,
      peakWeight: peakWeight(p.start, this.config.timeZone, tariff),
    }));

    const fixedActions = new Map<number, BatteryAction>();
    intervals.forEach((iv, i) => {
      const override = this.overrides.find((o) => o.from < iv.end && o.until > iv.start);
      if (override) fixedActions.set(i, override.action);
    });

    const reserveSoc = this.reserveSocAt(now);
    const plan = planBattery({
      intervals,
      socPct: live.socPct,
      capacityKwh: this.config.capacityKwh,
      reserveSocPct: reserveSoc,
      maxSocPct: this.config.maxSocPct,
      maxChargeKw: this.config.maxChargeKw,
      maxDischargeKw: this.config.maxDischargeKw,
      maxImportKw: this.config.maxImportKw || undefined,
      roundTripEfficiency: this.config.roundTripEfficiency,
      cyclingCostPerKwh: this.config.cyclingCostPerKwh,
      minGainPerKwh: this.config.minGainPerKwh,
      fixedActions,
      initialAction: running ?? undefined,
      holdStoresSurplus: this.directMode,
      peak: tariff.enabled ? {
        costPerKw: tariff.pricePerKwMonth / Math.max(1, tariff.peaks),
        thresholdKw: this.peakThresholdKw(),
        periodHours: tariff.periodMinutes / 60,
      } : undefined,
    });
    const schedule = planToSchedule(plan.intervals, {
      now,
      timeZone: this.config.timeZone,
      batteryVoltageV: live.batteryVoltageV || 420,
      maxChargeKw: this.config.maxChargeKw,
      maxSocPct: this.config.maxSocPct,
      slotCount: this.slotCount,
      reserveSocPct: reserveSoc,
    });
    return { generatedAt: now, reserveSoc, plan, schedule, pricesUntil: upcoming[upcoming.length - 1].end, negativeExport };
  }

  async readSettings(): Promise<InverterSettings> {
    this.lastRead = await this.transport.readSettings();
    this.lastReadAt = Date.now();
    this.slotCount = slotsFor(this.lastRead);
    return this.lastRead;
  }

  /** The settings as last read, when that was recently enough; otherwise read them now. */
  async recentSettings(now = Date.now()): Promise<InverterSettings> {
    return this.lastRead && now - this.lastReadAt < this.settingsMaxAgeMs ? this.lastRead : this.readSettings();
  }

  /**
   * What the schedule the app wrote does now: charge (a slot with current), hold (a 0 A slot) or
   * self-use. For the first plan after a restart, when there is no previous plan yet.
   */
  scheduledAction(now: Date): BatteryAction | null {
    if (!this.lastApplied) return null;
    const t = minutes(localHHMM(now, this.config.timeZone));
    const slot = this.lastApplied.chargeSlots.find((s) => s.enabled && ranges(s).some(([a, b]) => t >= a && t < b));
    return slot ? (slot.currentA > 0 ? 'charge' : 'hold') : 'self_use';
  }

  /** Makes the next update read the settings from the inverter. */
  expireKnown(): void {
    this.lastReadAt = 0;
  }

  /**
   * Settings reported with live data that differ from what the inverter should have (what the app
   * wrote, or else read), e.g. ["storage mode 49 ≠ 17"]. Empty when they match or nothing is known.
   */
  reportedDifferences(report: ReportedSettings): string[] {
    const expected = this.lastApplied ?? this.lastRead;
    if (!expected) return [];
    const out: string[] = [];
    if (report.storageModeRaw !== undefined) {
      const mask = report.storageModeMask ?? 0xffff;
      if ((report.storageModeRaw & mask) !== (expected.storageModeRaw & mask)) {
        out.push(`storage mode ${report.storageModeRaw} ≠ ${expected.storageModeRaw & mask}`);
      }
    }
    const fields = ['overDischargeSoc', 'forceChargeSoc'] as const;
    for (const field of fields) {
      const value = report[field];
      if (value !== undefined && value !== expected[field]) out.push(`${field} ${value} ≠ ${expected[field]}`);
    }
    return out;
  }

  get known(): KnownSettings {
    return { read: this.lastRead, readAt: this.lastReadAt, applied: this.lastApplied, writtenAt: this.lastWriteAt };
  }

  /** Takes over what an earlier run knew, so a restart does not read the inverter again. */
  restoreKnown(known: KnownSettings): void {
    this.lastRead = known.read;
    this.lastReadAt = known.readAt;
    this.lastApplied = known.applied;
    this.lastWriteAt = known.writtenAt ?? 0;
    if (known.read) this.slotCount = slotsFor(known.read);
  }

  /**
   * Switches export off while the export price is negative and back on afterwards. Only undoes
   * what the app did itself: export switched off by the user stays off. Returns what changed.
   */
  async applyExport(now: Date, state: PlanState | null): Promise<string | null> {
    if (!this.transport.writeExportAllowed) return null;
    const negative = state?.negativeExport.some((p) => p.start <= now && p.end > now) ?? false;
    const block = this.exportControl && negative;
    if (block && !this.exportBlockedByApp) {
      const current = await this.readSettings();
      if (current.exportAllowed !== true) return null; // already off (or unknown): leave it
      await this.transport.writeExportAllowed(false, true);
      this.exportBlockedByApp = true;
      return 'export off (negative export price)';
    }
    if (!block && this.exportBlockedByApp) {
      await this.transport.writeExportAllowed(true, false);
      this.exportBlockedByApp = false;
      return 'export on again';
    }
    return null;
  }

  /** Forgets what was written last, e.g. after monitor mode, so earlier values are not taken as outside changes. */
  forgetApplied(): void {
    this.lastApplied = null;
  }

  /**
   * Writes the schedule to the inverter. Only changed values are written. Returns what changed.
   * A failed write does not stop the others: the failures are thrown together at the end, so the
   * plan reports them and tries again at the next update.
   */
  async apply(state: PlanState, now = Date.now()): Promise<string[]> {
    // What the app wrote is what the inverter has, unless it is time to check for outside changes.
    const known = this.lastApplied && now - this.lastReadAt < this.settingsMaxAgeMs ? this.lastApplied : null;
    const current = known ?? await this.readSettings();
    const changes: string[] = [];
    const failures: string[] = [];
    const attempt = async (what: string, write: () => Promise<void>): Promise<boolean> => {
      this.lastWriteAt = Date.now();
      try {
        await write();
        changes.push(what);
        return true;
      } catch (err) {
        failures.push(`${what}: ${(err as Error).message}`);
        return false;
      }
    };
    const desired = this.desiredSettings(current, state);
    desired.chargeSlots = alignSlots(current.chargeSlots, desired.chargeSlots);
    this.externalChange = !known && this.lastApplied !== null && !settingsEqual(current, this.lastApplied);
    if (this.externalChange) this.log('Inverter settings were changed outside the app since the last update');

    // Slots first, so enabling time-of-use never activates stale slots. The inverter refuses to
    // switch on a slot that overlaps another active one (26 Sep 2026), so slots that change or go
    // away are switched off first, then the new ones are written and switched on.
    const kinds = [
      { kind: 'charge', now: current.chargeSlots, want: desired.chargeSlots, write: this.transport.writeChargeSlot.bind(this.transport) },
      { kind: 'discharge', now: current.dischargeSlots, want: desired.dischargeSlots, write: this.transport.writeDischargeSlot.bind(this.transport) },
    ] as const;
    const after = kinds.map((k) => k.now.slice(0, slotsFor(current)).map((slot) => ({ ...slot })));
    for (const [n, k] of kinds.entries()) {
      for (let i = 0; i < after[n].length; i++) {
        const now = after[n][i];
        if (!now.enabled || slotsEqual(now, k.want[i])) continue;
        const off = { ...now, enabled: false };
        if (await attempt(`${k.kind} slot ${i + 1}: off`, () => k.write(i, off, now))) after[n][i] = off;
      }
    }
    for (const [n, k] of kinds.entries()) {
      for (let i = 0; i < after[n].length; i++) {
        const want = k.want[i];
        if (slotsEqual(after[n][i], want)) continue;
        const clash = after.flat().find((other) => other !== after[n][i] && other.enabled && want.enabled && overlaps(other, want));
        if (clash) {
          failures.push(`${k.kind} slot ${i + 1}: not switched on, overlaps ${clash.start}-${clash.end} that could not be switched off`);
          continue;
        }
        await attempt(`${k.kind} slot ${i + 1}: ${describeSlot(want)}`, () => k.write(i, want, after[n][i]));
      }
    }
    if (current.reserveSoc !== desired.reserveSoc) {
      await attempt(`reserve SOC ${current.reserveSoc} → ${desired.reserveSoc}`,
        () => this.transport.writeReserveSoc(desired.reserveSoc, current.reserveSoc));
    }
    // With a slot not written, leave the work mode as it is: switching the schedule on could run a stale slot.
    if (current.storageModeRaw !== desired.storageModeRaw && failures.length === 0) {
      await attempt(`work mode ${this.workMode.describe(current.storageModeRaw)} → ${this.workMode.describe(desired.storageModeRaw)}`,
        () => this.transport.writeStorageMode(desired.storageModeRaw, current.storageModeRaw));
    }
    if (changes.length > 0) this.log('Applied', changes);
    if (failures.length > 0) {
      // Not all of the plan is in the inverter: do not take the difference for an outside change next time.
      this.lastApplied = null;
      throw new Error(`Not written: ${failures.join('; ')}`);
    }
    this.lastApplied = desired;
    // The inverter now has what was written. lastReadAt stays: the periodic check still reads it.
    this.lastRead = desired;
    return changes;
  }

  /**
   * Hands control back to the inverter: disables all time-of-use slots and the time-of-use
   * switch, so the inverter runs plain self-use. The reserve (backup) setting is kept.
   */
  async restoreInverter(): Promise<string[]> {
    this.lastApplied = null;
    this.lastWriteAt = Date.now();
    const current = await this.readSettings();
    const changes: string[] = [];
    if (this.exportBlockedByApp && this.transport.writeExportAllowed) {
      await this.transport.writeExportAllowed(true, false);
      this.exportBlockedByApp = false;
      changes.push('export on again');
    }
    for (let i = 0; i < slotsFor(current); i++) {
      if (current.chargeSlots[i].enabled) {
        await this.transport.writeChargeSlot(i, { ...current.chargeSlots[i], enabled: false }, current.chargeSlots[i]);
        changes.push(`charge slot ${i + 1}: off`);
      }
      if (current.dischargeSlots[i].enabled) {
        await this.transport.writeDischargeSlot(i, { ...current.dischargeSlots[i], enabled: false }, current.dischargeSlots[i]);
        changes.push(`discharge slot ${i + 1}: off`);
      }
    }
    const mode = this.workMode.released(current.storageModeRaw);
    if (mode !== current.storageModeRaw) {
      await this.transport.writeStorageMode(mode, current.storageModeRaw);
      changes.push(`work mode ${this.workMode.describe(current.storageModeRaw)} → ${this.workMode.describe(mode)}`);
    }
    this.log('Restored inverter', changes);
    return changes;
  }

  desiredSettings(current: InverterSettings, state: PlanState): InverterSettings {
    return {
      ...current,
      storageModeRaw: this.workMode.controlled(current.storageModeRaw, state.reserveSoc > 0),
      reserveSoc: state.reserveSoc,
      // The 3-slot format has no target level per slot: the plan's slot times end the charging.
      chargeSlots: this.directMode
        ? current.chargeSlots.map((s) => ({ ...s, enabled: false }))
        : current.touV2
          ? state.schedule.chargeSlots
          : state.schedule.chargeSlots.slice(0, slotsFor(current)).map((s) => ({ ...s, soc: 100 })),
      // Discharge is handled by self-use outside the charge slots.
      dischargeSlots: current.dischargeSlots.map(() => ({ ...DISABLED_SLOT })),
    };
  }

  /**
   * Yesterday, today and tomorrow (when published). Price days follow the market's time zone (CET),
   * so outside CET the first local hour can belong to the previous delivery day.
   */
  private async loadPrices(now: Date): Promise<SpotPrice[]> {
    const tz = this.config.timeZone;
    const [yesterday, today, tomorrow] = [-1, 0, 1].map((d) => localDate(addDays(now, d), tz));
    const optional = (date: string) => this.prices.getDay(date, this.config.priceArea).catch((err) => {
      this.log(`Prices for ${date} unavailable:`, err);
      return null;
    });
    const [a, b, c] = await Promise.all([optional(yesterday), this.prices.getDay(today, this.config.priceArea), optional(tomorrow)]);
    if (!b) throw new Error(`No prices for ${today}`);
    const byStart = new Map<number, SpotPrice>();
    for (const p of [...(a ?? []), ...b, ...(c ?? [])]) byStart.set(p.start.getTime(), p);
    return [...byStart.values()].sort((x, y) => x.start.getTime() - y.start.getTime());
  }
}

export function currentAction(state: PlanState | null, now: Date): BatteryAction | null {
  const iv = state?.plan.intervals.find((i) => i.start <= now && i.end > now);
  return iv?.action ?? null;
}

function settingsEqual(a: InverterSettings, b: InverterSettings): boolean {
  return a.storageModeRaw === b.storageModeRaw && a.reserveSoc === b.reserveSoc
    && a.chargeSlots.every((slot, i) => slotsEqual(slot, b.chargeSlots[i]))
    && a.dischargeSlots.every((slot, i) => slotsEqual(slot, b.dischargeSlots[i]));
}

function slotsEqual(a: TouSlot, b: TouSlot): boolean {
  if (!a.enabled && !b.enabled) return true;
  return a.enabled === b.enabled && a.start === b.start && a.end === b.end
    && a.currentA === b.currentA && a.soc === b.soc;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Minute ranges a daily slot covers; a slot past midnight is two ranges. */
function ranges(s: TouSlot): Array<[number, number]> {
  const a = minutes(s.start);
  const b = minutes(s.end);
  return b > a ? [[a, b]] : [[a, 1440], [0, b]];
}

export function overlaps(a: TouSlot, b: TouSlot): boolean {
  return ranges(a).some(([a0, a1]) => ranges(b).some(([b0, b1]) => a0 < b1 && b0 < a1));
}

/**
 * Places the planned slots so that a slot already running in the inverter keeps its position: a
 * planned slot identical to an active one stays there (nothing to write), the others take the
 * remaining positions, unused ones first. The inverter does not care about the order.
 */
export function alignSlots(current: TouSlot[], wanted: TouSlot[]): TouSlot[] {
  const placed: Array<TouSlot | null> = current.map(() => null);
  const rest: TouSlot[] = [];
  for (const slot of wanted.filter((s) => s.enabled)) {
    const i = current.findIndex((c, index) => placed[index] === null && c.enabled && slotsEqual(c, slot));
    if (i >= 0) placed[i] = slot;
    else rest.push(slot);
  }
  const free = placed.map((s, i) => i).filter((i) => placed[i] === null)
    .sort((a, b) => Number(current[a].enabled) - Number(current[b].enabled));
  for (const slot of rest) {
    const i = free.shift();
    if (i !== undefined) placed[i] = slot;
  }
  // Positions left over are switched off; their times and levels stay as they are (one write, not four).
  return placed.map((s, i) => s ?? { ...current[i], enabled: false });
}

function describeSlot(s: TouSlot): string {
  return s.enabled ? `${s.start}-${s.end} ${s.currentA} A → ${s.soc}%` : 'off';
}
