import { controlledStorageMode, describeStorageMode, withFlag } from '../inverter/storageMode.js';
import { DISABLED_SLOT, type InverterSettings, type InverterTransport, type LiveData, type TouSlot } from '../inverter/types.js';
import { type BatteryAction, planBattery, type PlanInterval, type PlanResult } from '../planner/planner.js';
import { planToSchedule, type Schedule } from '../planner/schedule.js';
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
}

const SLOT_COUNT = 6;

export class BatteryController {
  overrides: Override[] = [];
  outage: OutagePreparation | null = null;
  /** Expected house load in kW at a time, e.g. from a learned profile; null = use the average. */
  loadForecast: (time: Date) => number | null = () => null;
  /** Expected PV power in kW at a time; null = unknown (treated as no PV). */
  pvForecast: (time: Date) => number | null = () => null;

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

    const intervals: PlanInterval[] = upcoming.map((p) => ({
      start: p.start,
      end: p.end,
      buy: buyPrice(p.perKwh, p.start, this.config.timeZone, this.config.tariff),
      sell: sellPrice(p.perKwh, this.config.tariff),
      loadKw: this.loadForecast(p.start) ?? this.config.avgLoadKw,
      pvKw: (this.pvForecast(p.start) ?? 0) * this.config.pvTrust,
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
    });
    const schedule = planToSchedule(plan.intervals, {
      now,
      timeZone: this.config.timeZone,
      batteryVoltageV: live.batteryVoltageV || 420,
      maxChargeKw: this.config.maxChargeKw,
      maxSocPct: this.config.maxSocPct,
      slotCount: SLOT_COUNT,
      reserveSocPct: reserveSoc,
    });
    return { generatedAt: now, reserveSoc, plan, schedule, pricesUntil: upcoming[upcoming.length - 1].end };
  }

  /** Writes the schedule to the inverter. Only changed values are written. Returns what changed. */
  async apply(state: PlanState): Promise<string[]> {
    const current = await this.transport.readSettings();
    if (!current.touV2) {
      throw new Error('Inverter firmware does not use the 6-slot schedule; not supported yet');
    }
    const changes: string[] = [];
    const desired = this.desiredSettings(current, state);

    // Slots first, so enabling time-of-use never activates stale slots.
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (!slotsEqual(current.chargeSlots[i], desired.chargeSlots[i])) {
        await this.transport.writeChargeSlot(i, desired.chargeSlots[i], current.chargeSlots[i]);
        changes.push(`charge slot ${i + 1}: ${describeSlot(desired.chargeSlots[i])}`);
      }
      if (!slotsEqual(current.dischargeSlots[i], desired.dischargeSlots[i])) {
        await this.transport.writeDischargeSlot(i, desired.dischargeSlots[i], current.dischargeSlots[i]);
        changes.push(`discharge slot ${i + 1}: ${describeSlot(desired.dischargeSlots[i])}`);
      }
    }
    if (current.reserveSoc !== desired.reserveSoc) {
      await this.transport.writeReserveSoc(desired.reserveSoc, current.reserveSoc);
      changes.push(`reserve SOC ${current.reserveSoc} → ${desired.reserveSoc}`);
    }
    if (current.storageModeRaw !== desired.storageModeRaw) {
      await this.transport.writeStorageMode(desired.storageModeRaw, current.storageModeRaw);
      changes.push(`storage mode ${describeStorageMode(current.storageModeRaw)} → ${describeStorageMode(desired.storageModeRaw)}`);
    }
    if (changes.length > 0) this.log('Applied', changes);
    return changes;
  }

  /**
   * Hands control back to the inverter: disables all time-of-use slots and the time-of-use
   * switch, so the inverter runs plain self-use. The reserve (backup) setting is kept.
   */
  async restoreInverter(): Promise<string[]> {
    const current = await this.transport.readSettings();
    const changes: string[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      if (current.chargeSlots[i].enabled) {
        await this.transport.writeChargeSlot(i, { ...current.chargeSlots[i], enabled: false }, current.chargeSlots[i]);
        changes.push(`charge slot ${i + 1}: off`);
      }
      if (current.dischargeSlots[i].enabled) {
        await this.transport.writeDischargeSlot(i, { ...current.dischargeSlots[i], enabled: false }, current.dischargeSlots[i]);
        changes.push(`discharge slot ${i + 1}: off`);
      }
    }
    const mode = withFlag(current.storageModeRaw, 'timeOfUse', false);
    if (mode !== current.storageModeRaw) {
      await this.transport.writeStorageMode(mode, current.storageModeRaw);
      changes.push(`storage mode ${describeStorageMode(current.storageModeRaw)} → ${describeStorageMode(mode)}`);
    }
    this.log('Restored inverter', changes);
    return changes;
  }

  desiredSettings(current: InverterSettings, state: PlanState): InverterSettings {
    return {
      ...current,
      storageModeRaw: controlledStorageMode(current.storageModeRaw, state.reserveSoc > 0),
      reserveSoc: state.reserveSoc,
      chargeSlots: state.schedule.chargeSlots,
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

function slotsEqual(a: TouSlot, b: TouSlot): boolean {
  if (!a.enabled && !b.enabled) return true;
  return a.enabled === b.enabled && a.start === b.start && a.end === b.end
    && a.currentA === b.currentA && a.soc === b.soc;
}

function describeSlot(s: TouSlot): string {
  return s.enabled ? `${s.start}-${s.end} ${s.currentA} A → ${s.soc}%` : 'off';
}
