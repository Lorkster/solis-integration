import {
  DISABLED_SLOT, type InverterSettings, type InverterTransport, type LiveData, NO_WORK_MODE, type TouSlot, type WorkMode,
} from '../inverter/types.js';
import { type BatteryAction, planBattery, type PlanInterval, type PlanResult } from '../planner/planner.js';
import { planToSchedule, type Schedule } from '../planner/schedule.js';
import { NO_POWER_TARIFF, peakWeight, type PowerTariffConfig } from '../energy/PowerTariff.js';
import type { PriceArea, PriceProvider, SpotPrice } from '../prices/PriceProvider.js';
import { buyPrice, sellPrice, type TariffConfig } from '../tariff.js';
import { addDays, localDate, localParts } from '../time.js';

export interface ControllerConfig {
  timeZone: string;
  priceArea: PriceArea;
  tariff: TariffConfig;
  capacityKwh: number;
  maxChargeKw: number;
  maxDischargeKw: number;
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
  async buildPlan(live: LiveData, now: Date): Promise<PlanState> {
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
      roundTripEfficiency: this.config.roundTripEfficiency,
      cyclingCostPerKwh: this.config.cyclingCostPerKwh,
      minGainPerKwh: this.config.minGainPerKwh,
      fixedActions,
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
    this.slotCount = slotsFor(this.lastRead);
    return this.lastRead;
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
   * A failed write does not stop the others (a half-written schedule is worse than one wrong slot):
   * the failures are thrown together at the end, so the plan reports them and tries again.
   */
  async apply(state: PlanState): Promise<string[]> {
    const current = await this.readSettings();
    const changes: string[] = [];
    const failures: string[] = [];
    const attempt = async (what: string, write: () => Promise<void>) => {
      try {
        await write();
        changes.push(what);
      } catch (err) {
        failures.push(`${what}: ${(err as Error).message}`);
      }
    };
    const desired = this.desiredSettings(current, state);
    this.externalChange = this.lastApplied !== null && !settingsEqual(current, this.lastApplied);
    if (this.externalChange) this.log('Inverter settings were changed outside the app since the last update');

    // Slots first, so enabling time-of-use never activates stale slots. New and changed slots go
    // before switching old ones off: when a write fails, the previous plan's slots keep running
    // (26 Sep: an old slot held the same charge that a failed switch-on was meant to take over).
    const slotWrites: Array<{ off: boolean; what: string; write: () => Promise<void> }> = [];
    for (let i = 0; i < slotsFor(current); i++) {
      for (const [kind, now, want, write] of [
        ['charge', current.chargeSlots[i], desired.chargeSlots[i], this.transport.writeChargeSlot.bind(this.transport)],
        ['discharge', current.dischargeSlots[i], desired.dischargeSlots[i], this.transport.writeDischargeSlot.bind(this.transport)],
      ] as const) {
        if (slotsEqual(now, want)) continue;
        slotWrites.push({ off: !want.enabled, what: `${kind} slot ${i + 1}: ${describeSlot(want)}`, write: () => write(i, want, now) });
      }
    }
    for (const w of slotWrites.filter((x) => !x.off)) await attempt(w.what, w.write);
    if (failures.length === 0) for (const w of slotWrites.filter((x) => x.off)) await attempt(w.what, w.write);
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
    return changes;
  }

  /**
   * Hands control back to the inverter: disables all time-of-use slots and the time-of-use
   * switch, so the inverter runs plain self-use. The reserve (backup) setting is kept.
   */
  async restoreInverter(): Promise<string[]> {
    this.lastApplied = null;
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
      chargeSlots: current.touV2
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

function describeSlot(s: TouSlot): string {
  return s.enabled ? `${s.start}-${s.end} ${s.currentA} A → ${s.soc}%` : 'off';
}
