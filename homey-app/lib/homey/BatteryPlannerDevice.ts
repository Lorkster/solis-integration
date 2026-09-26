import Homey from 'homey';

import { BatteryController, type ControllerConfig, currentAction, type PlanState } from '../controller/BatteryController.js';
import { LoadProfile, type LoadProfileData } from '../forecast/LoadProfile.js';
import { ModelSkill, type SkillData } from '../forecast/ModelSkill.js';
import {
  type CalibrationData, createPvPowerProvider, looksCurtailed, SolarCalibration, SolarForecaster, type SolarSource,
} from '../forecast/SolarForecast.js';
import { extraPowerCost, houseSupply, type HouseSupply, usesSource } from '../energy/EnergyFlow.js';
import { ActualHistory, type ActualHistoryData } from '../energy/ActualHistory.js';
import {
  alternativeCheaper, type AlternativeHeat, breakEvenCost, fetchOutdoorTemperature, type LevelLimits, levelLimits, type PowerLevel,
  powerLevel,
} from '../energy/PowerLevel.js';
import { type PeakData, PeakTracker, type PowerTariffConfig } from '../energy/PowerTariff.js';
import { type SavingsData, SavingsTracker } from '../energy/Savings.js';
import { LockDetector } from '../inverter/LockDetector.js';
import { type ExportIssue, exportSettingIssue, ThrottleDetector } from '../inverter/ExportCheck.js';
import { type Deviation, type Expectation, PlanMonitor } from '../inverter/PlanMonitor.js';
import { type PowerCutEvent, type PowerCutState, PowerCutTracker } from '../inverter/PowerCut.js';
import { type InverterInfo, type InverterTransport, type LiveData, supportLevel, type WorkMode } from '../inverter/types.js';
import { bestWindow, type BestWindow, isBestTimeNow } from '../planner/bestTime.js';
import type { BatteryAction } from '../planner/planner.js';
import { displayAction, intervalState, liveState, planPeriods, planSummary } from '../planner/summary.js';
import {
  createPriceProvider, currencyForArea, FlowPriceProvider, parseFlowPrices, type PriceArea, type PriceSource,
} from '../prices/PriceProvider.js';
import { FailoverTransport } from '../inverter/FailoverTransport.js';
import { addDays, addMinutes, localDate, localHHMM } from '../time.js';
import { fetchMetNoWarnings } from '../warnings/MetNoWarnings.js';
import { fetchWarnings, type WarningLevel, type WeatherWarning } from '../warnings/SmhiWarnings.js';
import { energyChildren } from './EnergyChildDevice.js';

export type ControlMode = 'monitor' | 'auto';
export interface BestTimeArgs { minutes: number; power: number; deadline: string }
export type Settings = Record<string, number | string | boolean>;

/** A brand's ways to reach the inverter. Only one is used at a time. */
export interface Connections {
  /** The connection the user chose. */
  primary: InverterTransport;
  /** Used after the primary failed several times in a row, or null. */
  fallback: InverterTransport | null;
  /** Where past days' data comes from for learning (usually the cloud), or null. */
  history: InverterTransport | null;
}

const LIVE_INTERVAL_MS = 5 * 60_000;
const PLAN_INTERVAL_MS = 30 * 60_000;
const HISTORY_DAYS = 14;
const OUTAGE_HOURS_WITHOUT_END = 24;
/** Longest gap between two live samples that still counts as continuous measurement. */
const MAX_SAMPLE_GAP_H = 10 / 60;
const PEAK_CAPABILITIES = ['measure_solis_peak_month', 'measure_solis_peak_now'];

export const num = (value: unknown, fallback: number) => (Number.isFinite(Number(value)) && value !== '' && value !== null ? Number(value) : fallback);

/** Averages samples per quarter hour and reports each completed quarter. */
class QuarterAverager {
  private key = 0;
  private sum = 0;
  private n = 0;

  constructor(private readonly onQuarter: (start: Date, average: number) => void) {}

  add(time: Date, value: number): void {
    if (!Number.isFinite(value)) return;
    const key = Math.floor(time.getTime() / 900_000) * 900_000;
    if (this.n > 0 && key !== this.key) this.onQuarter(new Date(this.key), this.sum / this.n);
    if (key !== this.key) {
      this.key = key;
      this.sum = 0;
      this.n = 0;
    }
    this.sum += value;
    this.n++;
  }
}

/**
 * The home battery device, the same for every brand: plans, learns, measures and talks to Homey.
 * A brand's device extends it with how to reach its inverter (connections), how its work mode
 * changes (workMode) and brand-specific texts. See docs/ADDING-A-BRAND.md.
 */
export abstract class BatteryPlannerDevice extends Homey.Device {
  protected transport!: FailoverTransport;
  private liveTimer: NodeJS.Timeout | null = null;
  private lastPersist = 0;
  private lastDashboard = '';
  protected controller!: BatteryController;
  private loadProfile!: LoadProfile;
  private solar: SolarForecaster | null = null;
  private pvQuarters!: QuarterAverager;
  private live: LiveData | null = null;
  private planState: PlanState | null = null;
  private warnings: WeatherWarning[] = [];
  private lastAction: BatteryAction | null = null;
  private lastSampleTime = 0;
  private planning = false;
  /** Set while a brand talks to the inverter outside the plan (e.g. a Modbus command): plan updates wait. */
  protected inverterBusy = false;
  private chargeStall: { period: number; since: number } | null = null;
  /** Battery floor during a power outage, read from the inverter (Solis: 20-30 % by default). */
  private offGridFloorSoc: number | null = null;
  private readonly lock = new LockDetector();
  private supply: HouseSupply | null = null;
  private lastCostReported: number | null = null;
  private level: PowerLevel | null = null;
  private levelLimits: LevelLimits | null = null;
  private otherHeating: boolean | null = null;
  private breakEven: number | null = null;
  private outdoorC: number | null = null;
  private outdoorAt = 0;
  private flowPrices!: FlowPriceProvider;
  protected info: InverterInfo | null = null;
  private powerCut!: PowerCutTracker;
  private readonly monitor = new PlanMonitor();
  private offPlan: Deviation | ExportIssue | null = null;
  private readonly throttle = new ThrottleDetector();
  /** Best-time triggers already fired: flow arguments → until when (the run's deadline). */
  private readonly bestTimeFired = new Map<string, number>();
  private peaks!: PeakTracker; // actual import peaks
  private peaksWithoutBattery!: PeakTracker; // what the peaks would have been without the battery
  private savings!: SavingsTracker;
  private history!: ActualHistory;
  private peakRiskPeriod = 0;
  private peakRisk = false;
  private planError: string | null = null;

  // --- what a brand provides ----------------------------------------------------------------

  /** The brand's connections for these settings; throws when none is set up. */
  protected abstract connections(settings: Settings, id: string): Connections;

  /** How the brand's work mode changes when the app takes or hands back control. */
  protected abstract readonly workMode: WorkMode;

  /** The connection as shown in the device settings, e.g. "Modbus (192.168.1.50)". */
  protected connectionName(transport: InverterTransport): string {
    return transport.name;
  }

  /** How often live data is read over a local connection. */
  protected localLiveIntervalMs(): number {
    return 60_000;
  }

  /** Combines newly read inverter info with what was known before (e.g. a model name only the cloud reports). */
  protected mergeInfo(info: InverterInfo, _known: InverterInfo | null): InverterInfo {
    return info;
  }

  /** Charge slots in this inverter's schedule. */
  protected scheduleSlots(_info: InverterInfo): number {
    return 6;
  }

  /** False when the app cannot write this inverter's schedule over the current connection (plans are shown, nothing is written). */
  protected canControl(): boolean {
    return !this.info || supportLevel(this.info) === 'full';
  }

  /** Why the app only shows the plan, when canControl() is false. */
  protected cannotControlText(): string {
    return this.homey.__('device.cannotControl');
  }

  /**
   * A planned grid charge has not started for `minutes` (measured between the inverter's samples).
   * Brands can try to get it going; Solis sends a short Remote Dispatch command.
   */
  protected async onGridChargeStalled(_minutes: number, _periodStart: Date): Promise<void> {
    // Nothing by default: the plan check reports it after a while.
  }

  /** Warning while a remote command keeps the battery at 0 A (see LockDetector). */
  protected lockWarning(): string {
    return "Battery locked at 0 A by a remote command on the inverter. Release it in the inverter's own app.";
  }

  // --- life cycle ----------------------------------------------------------------------------

  override async onInit(): Promise<void> {
    const tz = this.homey.clock.getTimezone();
    this.flowPrices = new FlowPriceProvider(tz, this.getStoreValue('flowPrices') ?? []);
    this.info = (this.getStoreValue('inverterInfo') as InverterInfo | undefined) ?? null;
    this.powerCut = new PowerCutTracker(this.getStoreValue('powerCut') as PowerCutState | undefined);
    this.savings = new SavingsTracker(tz, this.getStoreValue('savings') as SavingsData | undefined);
    this.history = new ActualHistory(tz, this.getStoreValue('actualHistory') as ActualHistoryData | undefined);
    this.peaks = new PeakTracker(tz, this.powerTariff(), this.getStoreValue('peaks') as PeakData | undefined);
    this.peaksWithoutBattery = new PeakTracker(tz, this.powerTariff(), this.getStoreValue('peaksWithoutBattery') as PeakData | undefined);
    this.loadProfile = new LoadProfile(tz, this.getStoreValue('loadProfile') as LoadProfileData | undefined);
    this.pvQuarters = new QuarterAverager((start, kw) => {
      if (!this.solar) return;
      this.solar.learn(start, kw);
      this.setStoreValue('solarCalibration', this.solar.calibration.toJSON()).catch(this.error);
      this.setStoreValue('solarSkill', this.solar.skill.toJSON()).catch(this.error);
    });
    await this.migrateCapabilities();
    await this.migrateSettings();
    // New alarms start as "off" rather than unknown until their first change.
    for (const cap of ['alarm_solis_power_cut', 'alarm_solis_off_plan']) {
      if (this.hasCapability(cap) && this.getCapabilityValue(cap) === null) await this.setCapabilityValue(cap, false).catch(this.error);
    }
    this.createController();

    if (!this.getCapabilityValue('solis_control_mode')) {
      // Start passive: the inverter's own planning (e.g. the SolisCloud EMS) must be off before this app takes control.
      await this.setCapabilityValue('solis_control_mode', 'monitor');
    }
    this.registerCapabilityListener('solis_control_mode', async (mode: ControlMode) => {
      if (mode === 'auto' && !this.canControl()) throw new Error(this.cannotControlText());
      this.log('Control mode →', mode);
      this.controller.forgetApplied();
      this.homey.setTimeout(() => this.replan().catch(this.error), 1_000);
    });

    this.scheduleLive();
    this.homey.setInterval(() => this.replan().catch(this.error), PLAN_INTERVAL_MS);
    await this.refreshInfo().catch(this.error);
    await this.refreshLive().catch(this.error);
    await this.readInverterLimits().catch(this.error);
    await this.replan().catch(this.error);
    this.learnFromHistory().catch(this.error);
    this.learnPeaksFromHistory().catch(this.error);
  }

  /** Power fee settings (disabled unless switched on with a price). */
  private powerTariff(): PowerTariffConfig {
    const s = this.getSettings() as Settings;
    return {
      enabled: Boolean(s.power_tariff_enabled) && num(s.power_tariff_price, 0) > 0,
      pricePerKwMonth: num(s.power_tariff_price, 0),
      peaks: Math.max(1, Math.round(num(s.power_tariff_peaks, 3))),
      distinctDays: s.power_tariff_distinct_days !== false,
      periodMinutes: num(s.power_tariff_period, 60) === 15 ? 15 : 60,
      winterOnly: Boolean(s.power_tariff_winter_only),
      weekdaysOnly: Boolean(s.power_tariff_weekdays_only),
      fromHour: num(s.power_tariff_from, 0),
      toHour: num(s.power_tariff_to, 24),
      outsideWeight: num(s.power_tariff_outside_weight, 0) / 100,
    };
  }

  /** Reads live data again after the active connection's interval (local: every minute by default). */
  private scheduleLive(): void {
    if (this.liveTimer) this.homey.clearTimeout(this.liveTimer);
    this.liveTimer = this.homey.setTimeout(async () => {
      await this.refreshLive().catch(this.error);
      this.scheduleLive();
    }, this.liveIntervalMs());
  }

  private liveIntervalMs(): number {
    return this.transport?.kind === 'local' ? this.localLiveIntervalMs() : LIVE_INTERVAL_MS;
  }

  /** Model, firmware and what the app can do with this inverter; shown in the device settings. */
  private async refreshInfo(): Promise<void> {
    const info = this.mergeInfo(await this.transport.getInfo(), this.info);
    this.info = info;
    await this.setStoreValue('inverterInfo', info);
    await this.setSettings({
      inverter_model: info.modelCode ? `${info.model} (${info.modelCode})` : info.model,
      inverter_power: info.ratedPowerKw ? `${info.ratedPowerKw} kW` : '–',
      inverter_firmware: info.firmware || '–',
      inverter_support: this.homey.__(`device.support.${supportLevel(info)}`),
      inverter_connection: this.connectionText(),
    });
    if (!this.canControl() && this.controlMode === 'auto') await this.setCapabilityValue('solis_control_mode', 'monitor');
    this.createController();
    this.controller.slotCount = this.scheduleSlots(info);
  }

  get currency(): string {
    return currencyForArea(String(this.getSetting('price_area')));
  }

  /** Prices from the "Set electricity prices" flow card. */
  async setFlowPrices(text: string): Promise<void> {
    const added = this.flowPrices.merge(parseFlowPrices(text));
    await this.setStoreValue('flowPrices', this.flowPrices.toJSON());
    this.log(`Received ${added} quarter-hours of prices from a flow`);
    if (this.getSetting('price_source') === 'flow') await this.replan();
  }

  private async readInverterLimits(): Promise<void> {
    const settings = await this.controller.readSettings();
    this.offGridFloorSoc = settings.offGridOverDischargeSoc;
    await this.setStoreValue('offGridFloorSoc', this.offGridFloorSoc);
  }

  override async onSettings({ changedKeys }: { changedKeys: string[] }): Promise<void> {
    this.log('Settings changed:', changedKeys);
    const solarChanged = changedKeys.some((k) => k.startsWith('pv_array') || k === 'pv_source' || k === 'solcast_sites' || k === 'pv_weather_model');
    const tariffChanged = changedKeys.some((k) => k.startsWith('power_tariff'));
    const connectionChanged = changedKeys.some((k) => k.startsWith('modbus_') || k.startsWith('connection_') || k.startsWith('key_'));
    this.homey.setTimeout(async () => {
      if (tariffChanged) {
        // Peaks are measured differently now: start over from the history of this month.
        const tz = this.homey.clock.getTimezone();
        this.peaks = new PeakTracker(tz, this.powerTariff());
        this.peaksWithoutBattery = new PeakTracker(tz, this.powerTariff());
        await this.unsetStoreValue('peaksLearned').catch(this.error);
        await this.migrateCapabilities();
      }
      if (solarChanged) {
        // New orientation: the previous calibration no longer applies.
        await this.unsetStoreValue('solarCalibration').catch(this.error);
        await this.unsetStoreValue('solarSkill').catch(this.error);
        await this.unsetStoreValue('historyLearned').catch(this.error);
        await this.unsetStoreValue('skillLearned').catch(this.error);
      }
      this.createController();
      if (connectionChanged) {
        await this.refreshInfo().catch(this.error);
        this.scheduleLive();
      }
      await this.replan().catch(this.error);
      if (solarChanged) this.learnFromHistory().catch(this.error);
      if (tariffChanged) this.learnPeaksFromHistory().catch(this.error);
    }, 500);
  }

  override async onUninit(): Promise<void> {
    await this.persistLearning(true).catch(this.error);
  }

  override async onDeleted(): Promise<void> {
    if (this.controlMode === 'auto') {
      // Do not leave the app's schedule repeating in the inverter.
      await this.controller.restoreInverter().catch(this.error);
    }
  }

  // --- used by flow cards and widgets -------------------------------------------------------

  get controlMode(): ControlMode {
    return (this.getCapabilityValue('solis_control_mode') as ControlMode) ?? 'monitor';
  }

  async setControlMode(mode: ControlMode): Promise<void> {
    if (mode === 'auto' && !this.canControl()) throw new Error(this.cannotControlText());
    if (mode !== this.controlMode) this.controller.forgetApplied();
    await this.setCapabilityValue('solis_control_mode', mode);
    await this.replan();
  }

  async addOverride(action: 'charge' | 'hold', minutes: number): Promise<void> {
    const now = new Date();
    this.controller.overrides.push({ action, from: now, until: addMinutes(now, minutes) });
    await this.saveOverrides();
    await this.replan();
  }

  async prepareOutage(hours: number): Promise<void> {
    this.controller.outage = { targetSoc: Number(this.getSetting('outage_target')), until: addMinutes(new Date(), hours * 60) };
    await this.saveOverrides();
    await this.replan();
  }

  async clearOverrides(): Promise<void> {
    this.controller.overrides = [];
    this.controller.outage = null;
    await this.saveOverrides();
    // Do not re-arm outage preparation for warnings the user already dismissed.
    const dismissed = new Set((this.getStoreValue('dismissedWarnings') as string[] | undefined) ?? []);
    for (const w of this.warnings) dismissed.add(w.id);
    await this.setStoreValue('dismissedWarnings', [...dismissed].slice(-50));
    await this.replan();
  }

  /** Clears the app's schedule from the inverter and switches to monitor mode. */
  async restoreInverter(): Promise<void> {
    await this.setCapabilityValue('solis_control_mode', 'monitor');
    const changes = await this.controller.restoreInverter();
    this.log('Handed control back to the inverter:', changes.join('; ') || 'nothing to change');
    await this.replan();
  }

  usesSource(part: 'solar' | 'battery' | 'grid'): boolean {
    return this.supply ? usesSource(this.supply.source, part) : false;
  }

  solarSurplusW(): number {
    return this.supply?.surplusW ?? 0;
  }

  /** What one more kWh costs right now (per kWh, in the price area's currency), or null before the first plan. */
  extraPowerCost(): number | null {
    const now = new Date();
    const iv = this.planState?.plan.intervals.find((i) => i.start <= now && i.end > now);
    if (!iv || !this.live) return null;
    return extraPowerCost(this.live.gridPowerW, iv.buy, iv.sell, iv.storedEnergyValue);
  }

  /** Cheap, normal or expensive now (null before the first plan). */
  powerLevel(): PowerLevel | null {
    return this.level;
  }

  /** True when the other heating (e.g. firewood) gives cheaper heat than the heat pump now; null before the first plan. */
  otherHeatingCheaper(): boolean | null {
    return this.otherHeating;
  }

  currentAction(): BatteryAction | null {
    return currentAction(this.planState, new Date());
  }

  hasWeatherWarning(): boolean {
    return this.warnings.length > 0;
  }

  isPowerCut(): boolean {
    return this.powerCut.active;
  }

  isPeakRisk(): boolean {
    return this.peakRisk;
  }

  /** Cheapest window for an appliance run, from the current plan. */
  bestWindow(args: BestTimeArgs): BestWindow | null {
    const intervals = this.planState?.plan.intervals ?? [];
    return bestWindow(intervals, new Date(), Number(args.minutes), Number(args.power), args.deadline, this.homey.clock.getTimezone());
  }

  isBestTimeNow(args: BestTimeArgs): boolean {
    return isBestTimeNow(this.bestWindow(args), new Date());
  }

  /** Tokens for the "Find the best time" action. */
  findBestTime(args: BestTimeArgs): { start: string; end: string; minutes_until: number; cost: number } {
    const best = this.bestWindow(args);
    if (!best) throw new Error(this.homey.__('bestTime.unknown'));
    const tz = this.homey.clock.getTimezone();
    return {
      start: localHHMM(best.start, tz),
      end: localHHMM(best.end, tz),
      minutes_until: Math.max(0, Math.round((best.start.getTime() - Date.now()) / 60_000)),
      cost: Math.round(best.costPerKwh * 100) / 100,
    };
  }

  /** Fires "It is the best time to run…" for every flow whose best window starts now (once per run). */
  private async checkBestTimeTriggers(): Promise<void> {
    if (!this.planState) return;
    const card = this.homey.flow.getDeviceTriggerCard('best_time_to_run');
    const all = await card.getArgumentValues(this) as BestTimeArgs[];
    const now = Date.now();
    for (const [key, until] of this.bestTimeFired) if (until <= now) this.bestTimeFired.delete(key);
    const tz = this.homey.clock.getTimezone();
    for (const args of all) {
      const key = `${args.minutes}|${args.power}|${args.deadline}`;
      if (this.bestTimeFired.has(key)) continue;
      const best = this.bestWindow(args);
      if (!best || !isBestTimeNow(best, new Date())) continue;
      this.bestTimeFired.set(key, best.end.getTime());
      await card.trigger(this, { end: localHHMM(best.end, tz), cost: Math.round(best.costPerKwh * 100) / 100 }, args).catch(this.error);
    }
  }

  isPriceAmongCheapest(hours: number): boolean {
    const now = new Date();
    const tz = this.homey.clock.getTimezone();
    const today = localDate(now, tz);
    const intervals = (this.planState?.plan.intervals ?? []).filter((iv) => localDate(iv.start, tz) === today);
    const current = intervals.find((iv) => iv.start <= now && iv.end > now);
    if (!current) return false;
    const cheapest = [...intervals].sort((a, b) => a.buy - b.buy).slice(0, Math.round(hours * 4));
    return cheapest.includes(current);
  }

  /** What really happens now, when it differs from the plan's self-use period (else null). */
  private nowState(): string | null {
    const state = this.planState;
    if (!state || !this.live) return null;
    const now = new Date();
    const [current] = planPeriods(state.plan.intervals.filter((iv) => iv.end > now), state.reserveSoc, this.controller.config.maxSocPct);
    if (!current) return null;
    const actual = liveState(current.state, { socPct: this.live.socPct, batteryW: this.live.batteryPowerW, gridW: this.live.gridPowerW },
      state.reserveSoc, this.controller.config.maxSocPct);
    return actual && actual !== current.state ? actual : null;
  }

  /**
   * The dashboard's data as a hidden device value, so the dashboard page can read it with a Homey
   * API key that may only read devices ("Devices: read only") – no access to apps or settings.
   */
  private async publishDashboard(): Promise<void> {
    if (!this.hasCapability('solis_dashboard')) return;
    const json = JSON.stringify(this.getView());
    if (json === this.lastDashboard) return;
    this.lastDashboard = json;
    await this.setCapabilityValue('solis_dashboard', json).catch(this.error);
  }

  /** Latest live values, for the solar panel and grid meter devices. */
  latestLive(): LiveData | null {
    return this.live;
  }

  /** Passes new values to this inverter's solar panel and grid meter devices (Homey Energy). */
  private async updateEnergyDevices(live: LiveData): Promise<void> {
    const { id } = this.getData() as { id: string };
    for (const device of energyChildren(this.homey, id)) await device.onLive(live).catch(this.error);
  }

  /** Data for the dashboard widgets. */
  getView(): unknown {
    const state = this.planState;
    const live = this.live;
    const round = (v: number, d = 0) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
    return {
      ready: Boolean(state),
      timeZone: this.homey.clock.getTimezone(),
      language: this.homey.i18n.getLanguage(),
      currency: this.currency,
      controlMode: this.controlMode,
      live: live && {
        at: live.timestamp.toISOString(),
        socPct: round(live.socPct),
        batteryW: round(live.batteryPowerW),
        pvW: round(live.pvPowerW),
        gridW: round(live.gridPowerW),
        loadW: round(live.loadPowerW),
        backupHours: round(this.backupHours(live), 1),
      },
      warnings: this.warnings.map((w) => ({
        level: w.level, title: w.title, area: w.areaName, start: w.start?.toISOString() ?? null, end: w.end?.toISOString() ?? null,
      })),
      outageUntil: this.controller.outage?.until.toISOString() ?? null,
      offGridFloorSoc: this.backupFloor(),
      batteryLocked: this.lock.locked,
      supply: this.supply && {
        source: this.supply.source,
        title: this.sourceTitle(this.supply.source),
        solarPct: this.supply.solarPct,
        batteryPct: this.supply.batteryPct,
        gridPct: this.supply.gridPct,
        surplusW: Math.round(this.supply.surplusW),
      },
      extraPowerCost: round(this.extraPowerCost() ?? NaN, 2),
      powerLevel: this.level && {
        level: this.level,
        cheapBelow: round(this.levelLimits?.cheapBelow ?? NaN, 2),
        expensiveAbove: round(this.levelLimits?.expensiveAbove ?? NaN, 2),
        otherHeatingCheaper: this.otherHeating,
        breakEven: round(this.breakEven ?? NaN, 2),
        outdoorC: round(this.outdoorC ?? NaN, 1),
      },
      powerCut: this.powerCut.since && { since: this.powerCut.since.toISOString() },
      exportPaused: this.controller.exportBlockedByApp,
      offPlan: this.offPlan && this.deviationText(this.offPlan),
      savings: { today: round(this.savedToday(), 2), month: round(this.savedThisMonth(), 0) },
      peak: this.powerTariff().enabled ? {
        monthKw: round(this.peaks.feeLevelKw(), 2),
        thresholdKw: round(this.peaks.thresholdKw(), 2),
        nowKw: round(this.projectedPeakKw() ?? NaN, 2),
        risk: this.peakRisk,
      } : null,
      plan: state && {
        generatedAt: state.generatedAt.toISOString(),
        reserveSoc: state.reserveSoc,
        savingsSek: round(state.plan.savingsSek, 1),
        warnings: state.schedule.warnings,
        slots: state.schedule.chargeSlots.filter((s) => s.enabled),
        learnedLoad: this.loadProfile.observations >= 96 * 3,
        solarForecast: Boolean(this.solar),
        nowState: this.nowState(),
        // The last 12 hours as measured, with what the day's first plan expected.
        past: this.history.since(new Date(Date.now() - 12 * 3_600_000)),
        periods: planPeriods(state.plan.intervals, state.reserveSoc, this.controller.config.maxSocPct).map((p) => ({
          state: p.state,
          start: p.start.toISOString(),
          end: p.end.toISOString(),
          socEnd: round(p.socEndPct),
        })),
        intervals: state.plan.intervals.map((iv) => ({
          t: iv.start.toISOString(),
          price: round(iv.buy, 3),
          // Holds at the reserve keep nothing and are not sent to the inverter; show them as self-use.
          state: intervalState(iv, state.reserveSoc, this.controller.config.maxSocPct),
          soc: round(iv.socEndPct, 1),
          loadKw: round(this.loadProfile.predict(iv.start) ?? this.controller.config.avgLoadKw, 2),
          pvKw: round(this.solar?.forecastAt(iv.start) ?? 0, 2),
        })),
      },
    };
  }

  // --- internals -----------------------------------------------------------------------------

  /**
   * Early versions used the normal grid fee (0.244) as a placeholder for the high-load fee. A device
   * still holding both at exactly that value never had its high-load fee filled in, so it gets
   * Vattenfall's 2026 high-load fee (0.612 ex VAT). Runs once; a value set by the user is kept.
   */
  private async migrateSettings(): Promise<void> {
    if (this.getStoreValue('highLoadFeeMigrated')) return;
    const s = this.getSettings() as Settings;
    if (Number(s.grid_fee_high) === 0.244 && Number(s.grid_fee) === 0.244) {
      await this.setSettings({ grid_fee_high: 0.612 });
      this.log('High-load grid fee set to 0.612 (was the 0.244 placeholder)');
    }
    await this.setStoreValue('highLoadFeeMigrated', true);
  }

  /** Capabilities were renamed during development; keep existing devices in line with the driver. */
  private async migrateCapabilities(): Promise<void> {
    const hidden = this.powerTariff().enabled ? [] : PEAK_CAPABILITIES;
    const wanted = (this.driver.manifest as { capabilities: string[] }).capabilities.filter((c) => !hidden.includes(c));
    for (const cap of this.getCapabilities()) {
      if (!wanted.includes(cap)) await this.removeCapability(cap).catch(this.error);
    }
    for (const cap of wanted) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }
  }

  private createController(): void {
    const s = this.getSettings() as Settings;
    const { id } = this.getData() as { id: string };
    const tz = this.homey.clock.getTimezone();
    this.transport = this.createTransport(s, id);
    this.applyCurrencyUnits().catch(this.error);
    const config: ControllerConfig = {
      timeZone: tz,
      priceArea: s.price_area as PriceArea,
      tariff: {
        vatFactor: 1 + Number(s.vat_pct) / 100,
        supplierFeeSekPerKwh: Number(s.supplier_fee),
        energyTaxSekPerKwh: Number(s.electricity_tax),
        gridFeeSekPerKwh: Number(s.grid_fee),
        gridFeeHighLoadSekPerKwh: Number(s.grid_fee_high),
        highLoadEnabled: Boolean(s.high_load_enabled),
        highLoad: {
          fromHour: num(s.high_load_from, 6),
          toHour: num(s.high_load_to, 22),
          weekdaysOnly: s.high_load_weekdays !== false,
          winterOnly: s.high_load_winter !== false,
          holidaysExcluded: s.high_load_holidays !== false,
        },
        exportBonusSekPerKwh: Number(s.export_bonus),
      },
      capacityKwh: Number(s.capacity_kwh),
      maxChargeKw: Number(s.max_charge_kw),
      maxDischargeKw: Number(s.max_discharge_kw),
      roundTripEfficiency: Number(s.round_trip_efficiency) / 100,
      cyclingCostPerKwh: Number(s.cycling_cost),
      minGainPerKwh: Number(s.min_gain),
      reserveSocSummer: Number(s.reserve_summer),
      reserveSocWinter: Number(s.reserve_winter),
      maxSocPct: Number(s.max_soc),
      avgLoadKw: Number(s.avg_load_kw),
      pvTrust: Number(s.pv_trust) / 100,
      powerTariff: this.powerTariff(),
    };

    this.solar = null;
    if (s.pv_forecast_enabled) {
      const arrays = [1, 2]
        .map((n) => ({ kwp: Number(s[`pv_array${n}_kwp`]), tilt: Number(s[`pv_array${n}_tilt`]), azimuth: Number(s[`pv_array${n}_azimuth`]) }))
        .filter((a) => a.kwp > 0);
      const latitude = this.homey.geolocation.getLatitude();
      const longitude = this.homey.geolocation.getLongitude();
      if (arrays.length > 0 && Number.isFinite(latitude) && Number.isFinite(longitude)) {
        const calibration = new SolarCalibration(tz, this.getStoreValue('solarCalibration') as CalibrationData | undefined);
        const maxAcKw = this.info?.ratedPowerKw ?? 20;
        try {
          const provider = createPvPowerProvider(s.pv_source as SolarSource, String(s.pv_api_key ?? ''), String(s.solcast_sites ?? ''),
            String(s.pv_weather_model ?? 'blend'));
          const skill = new ModelSkill(this.getStoreValue('solarSkill') as SkillData | undefined);
          this.solar = new SolarForecaster({ latitude, longitude, arrays, performanceRatio: 0.85, maxAcKw }, calibration, provider, skill);
        } catch (err) {
          this.error('Solar forecast disabled:', err);
        }
      }
    }

    const previous = this.controller;
    const prices = createPriceProvider(s.price_source as PriceSource, this.flowPrices);
    this.controller = new BatteryController(this.transport, prices, config, (...args) => this.log(...args));
    this.controller.workMode = this.workMode;
    this.controller.loadForecast = (time) => this.loadProfile.predict(time);
    this.controller.pvForecast = (time) => this.solar?.forecastAt(time) ?? null;
    this.controller.peakThresholdKw = () => this.peaks?.thresholdKw() ?? 0;
    this.controller.exportBlockedByApp = previous?.exportBlockedByApp ?? Boolean(this.getStoreValue('exportBlockedByApp'));
    this.controller.lastRead = previous?.lastRead ?? null;
    if (previous) {
      this.controller.overrides = previous.overrides;
      this.controller.outage = previous.outage;
    } else {
      this.restoreOverrides();
    }
  }

  /** The brand's connections behind one transport that uses one of them at a time. */
  private createTransport(s: Settings, id: string): FailoverTransport {
    const { primary, fallback, history } = this.connections(s, id);
    return new FailoverTransport(primary, fallback, history, (active, reason) => {
      this.log(`Connection → ${active.name}: ${reason}`);
      this.setSettings({ inverter_connection: this.connectionText() }).catch(this.error);
      this.scheduleLive();
    });
  }

  private connectionText(): string {
    const t = this.transport;
    if (!t) return '–';
    const name = this.connectionName(t.active);
    return t.onFallback ? `${name} – ${this.homey.__('device.fallback')}` : name;
  }

  /** Saves what the app learns at most every 5 minutes, however often values are read. */
  private async persistLearning(force = false): Promise<void> {
    if (!force && Date.now() - this.lastPersist < 5 * 60_000) return;
    this.lastPersist = Date.now();
    await this.setStoreValue('loadProfile', this.loadProfile.toJSON());
    await this.setStoreValue('savings', this.savings.toJSON());
    await this.setStoreValue('actualHistory', this.history.toJSON());
    if (this.powerTariff().enabled) {
      await this.setStoreValue('peaks', this.peaks.toJSON());
      await this.setStoreValue('peaksWithoutBattery', this.peaksWithoutBattery.toJSON());
    }
  }

  /** Price capabilities show the price area's currency. */
  private async applyCurrencyUnits(): Promise<void> {
    const units = `${this.currency}/kWh`;
    const sign = ({ SEK: 'kr', NOK: 'kr', DKK: 'kr', EUR: '€', PLN: 'zł' } as Record<string, string>)[this.currency] ?? this.currency;
    const wanted: Record<string, string> = {
      measure_solis_price: units,
      measure_solis_power_cost: units,
      measure_solis_saved_today: sign,
      measure_solis_saved_month: sign,
    };
    for (const [cap, unit] of Object.entries(wanted)) {
      if (!this.hasCapability(cap)) continue;
      const current = (this.getCapabilityOptions(cap) as { units?: unknown }).units;
      if (current !== unit) await this.setCapabilityOptions(cap, { units: unit });
    }
  }

  /** Manual overrides survive app restarts and updates. */
  private async saveOverrides(): Promise<void> {
    await this.setStoreValue('overrides', {
      overrides: this.controller.overrides.map((o) => ({ action: o.action, from: o.from.toISOString(), until: o.until.toISOString() })),
      outage: this.controller.outage && { targetSoc: this.controller.outage.targetSoc, until: this.controller.outage.until.toISOString() },
    });
  }

  private restoreOverrides(): void {
    const stored = this.getStoreValue('overrides') as {
      overrides?: Array<{ action: 'charge' | 'hold'; from: string; until: string }>;
      outage?: { targetSoc: number; until: string } | null;
    } | undefined;
    if (!stored) return;
    const now = Date.now();
    this.controller.overrides = (stored.overrides ?? [])
      .map((o) => ({ action: o.action, from: new Date(o.from), until: new Date(o.until) }))
      .filter((o) => o.until.getTime() > now);
    if (stored.outage && new Date(stored.outage.until).getTime() > now) {
      this.controller.outage = { targetSoc: stored.outage.targetSoc, until: new Date(stored.outage.until) };
    }
  }

  private async refreshLive(): Promise<void> {
    try {
      const live = await this.transport.getLiveData();
      this.live = live;
      if (live.timestamp.getTime() > this.lastSampleTime) {
        const gapH = this.lastSampleTime ? (live.timestamp.getTime() - this.lastSampleTime) / 3_600_000 : LIVE_INTERVAL_MS / 3_600_000;
        this.lastSampleTime = live.timestamp.getTime();
        await this.measure(live, Math.min(gapH, MAX_SAMPLE_GAP_H));
        await this.updatePowerCut(live);
        this.loadProfile.addSample(live.timestamp, live.loadPowerW / 1000);
        const curtailed = looksCurtailed(live.pvPowerW / 1000, live.loadPowerW / 1000, live.gridPowerW / 1000, live.batteryPowerW / 1000);
        this.pvQuarters.add(live.timestamp, curtailed ? NaN : live.pvPowerW / 1000);
        if (!curtailed) this.solar?.observe(live.timestamp, live.pvPowerW / 1000);
        // Throttling the app asked for (negative export price) is not a problem.
        const expected = this.controller.exportBlockedByApp ? null : this.solar?.forecastAt(live.timestamp) ?? null;
        this.throttle.update(live.timestamp, curtailed, expected, live.pvPowerW / 1000);
        await this.persistLearning();
      }
      await this.setAvailable();
      await this.updateExport().catch((err) => this.error('Export control failed:', err));
      await this.checkBestTimeTriggers().catch(this.error);
      await this.updateLock(live);
      await this.updateEnergyFlow(live);
      // The tile's "now" follows live data between plan updates.
      if (this.planState) await this.setCapabilityValue('solis_plan_status', this.summarise(this.planState));
      const set = (cap: string, value: number) => (Number.isFinite(value) ? this.setCapabilityValue(cap, value) : undefined);
      await Promise.all([
        set('measure_battery', live.socPct),
        set('measure_power', live.batteryPowerW),
        set('meter_power.charged', live.batteryChargedTotalKwh),
        set('meter_power.discharged', live.batteryDischargedTotalKwh),
        set('measure_solis_pv', live.pvPowerW),
        set('measure_solis_grid', live.gridPowerW),
        set('measure_solis_load', live.loadPowerW),
        set('measure_solis_backup_hours', this.backupHours(live)),
      ]);
      this.homey.api.realtime('live', null);
      await this.publishDashboard();
      await this.updateEnergyDevices(live);
    } catch (err) {
      this.error('Live data failed:', err);
      if (!this.live) await this.setUnavailable(`${this.transport?.name ?? '–'}: ${(err as Error).message}`);
    } finally {
      await this.checkPlan().catch(this.error);
      await this.checkGridCharge().catch(this.error);
      await this.refreshWarning().catch(this.error);
    }
  }

  // --- measured savings and power peaks ------------------------------------------------------

  /** Books one live sample into the savings and peak trackers. */
  private async measure(live: LiveData, hours: number): Promise<void> {
    const t = live.timestamp;
    const iv = this.planState?.plan.intervals.find((i) => i.start <= t && i.end > t);
    this.history.add(t, live.socPct, live.pvPowerW / 1000, live.loadPowerW / 1000, iv?.buy ?? null);
    if (iv && !this.powerCut.active) {
      this.savings.add({
        time: t, hours, gridW: live.gridPowerW, loadW: live.loadPowerW, pvW: live.pvPowerW, buy: iv.buy, sell: iv.sell,
        batteryKwh: live.socPct / 100 * this.controller.config.capacityKwh,
        storedValue: Math.min(iv.buy, iv.storedEnergyValue),
      });
    }
    const tariff = this.powerTariff();
    if (tariff.enabled) {
      this.peaks.addSample(t, live.gridPowerW);
      this.peaksWithoutBattery.addSample(t, live.loadPowerW - live.pvPowerW);
      const month = localDate(t, this.homey.clock.getTimezone()).slice(0, 7);
      this.savings.setPowerFeeSaving(month, this.peaksWithoutBattery.feeSoFar() - this.peaks.feeSoFar());
      await this.updatePeakRisk(live);
    }
    await this.dailySummary();
    const set = (cap: string, value: number | null) => (this.hasCapability(cap) && value !== null && Number.isFinite(value)
      ? this.setCapabilityValue(cap, value) : undefined);
    await Promise.all([
      set('measure_solis_saved_today', Math.round(this.savedToday() * 100) / 100),
      set('measure_solis_saved_month', Math.round(this.savedThisMonth())),
      set('measure_solis_peak_month', Math.round(this.peaks.feeLevelKw() * 100) / 100),
      set('measure_solis_peak_now', this.projectedPeakKw()),
    ]);
  }

  private savedToday(): number {
    return this.savings.savedOn(localDate(new Date(), this.homey.clock.getTimezone()));
  }

  private savedThisMonth(): number {
    return this.savings.savedInMonth(localDate(new Date(), this.homey.clock.getTimezone()).slice(0, 7));
  }

  /** Where this hour's (or quarter's) weighted average import is heading, or null outside counted hours. */
  private projectedPeakKw(): number | null {
    if (!this.live || !this.powerTariff().enabled) return null;
    const kw = this.peaks.projectedKw(new Date(), this.live.gridPowerW);
    return kw === null ? null : Math.round(kw * 100) / 100;
  }

  /** Warns (once per period) when the import is heading above the month's peak level. */
  private async updatePeakRisk(live: LiveData): Promise<void> {
    const now = new Date();
    const expected = this.peaks.projectedKw(now, live.gridPowerW);
    const level = this.peaks.thresholdKw();
    this.peakRisk = expected !== null && level > 0 && expected > level;
    const periodMs = this.powerTariff().periodMinutes * 60_000;
    const period = Math.floor(now.getTime() / periodMs) * periodMs;
    if (this.peakRisk && period !== this.peakRiskPeriod) {
      this.peakRiskPeriod = period;
      await this.homey.flow.getDeviceTriggerCard('peak_risk')
        .trigger(this, { expected: Math.round(expected! * 100) / 100, peak: Math.round(level * 100) / 100 }).catch(this.error);
    }
  }

  /** Just after midnight: what the battery saved the day before. */
  private async dailySummary(): Promise<void> {
    const tz = this.homey.clock.getTimezone();
    const today = localDate(new Date(), tz);
    const last = this.getStoreValue('summaryDay') as string | undefined;
    if (last === today) return;
    await this.setStoreValue('summaryDay', today);
    if (!last) return;
    const day = Math.round(this.savings.savedOn(last) * 100) / 100;
    const month = Math.round(this.savings.savedInMonth(last.slice(0, 7)));
    await this.homey.flow.getDeviceTriggerCard('day_summary')
      .trigger(this, { saved_day: day, saved_month: month, peak_month: Math.round(this.peaks.feeLevelKw() * 100) / 100 })
      .catch(this.error);
    if (this.getSetting('notify_daily')) {
      await this.notify(this.homey.__('summary', { day: this.formatMoney(day), month: this.formatMoney(month), currency: this.currencySign() }));
    }
  }

  /** Seeds this month's peaks from the connection's history (e.g. SolisCloud's 5-minute data) when the power fee is switched on. */
  private async learnPeaksFromHistory(): Promise<void> {
    if (!this.powerTariff().enabled || !this.transport.getHistory || this.getStoreValue('peaksLearned')) return;
    const tz = this.homey.clock.getTimezone();
    const tariff = this.powerTariff();
    const peaks = new PeakTracker(tz, tariff);
    const without = new PeakTracker(tz, tariff);
    const month = localDate(new Date(), tz).slice(0, 7);
    for (let d = HISTORY_DAYS; d >= 1; d--) {
      const date = localDate(addDays(new Date(), -d), tz);
      if (!date.startsWith(month)) continue;
      try {
        for (const sample of await this.transport.getHistory(date, tz)) {
          peaks.addSample(sample.time, sample.gridW);
          without.addSample(sample.time, sample.loadW - sample.pvW);
        }
      } catch (err) {
        this.error(`History for ${date} failed:`, err);
      }
    }
    this.peaks = peaks;
    this.peaksWithoutBattery = without;
    await this.setStoreValue('peaks', peaks.toJSON());
    await this.setStoreValue('peaksWithoutBattery', without.toJSON());
    await this.setStoreValue('peaksLearned', true);
    this.log(`Power peaks this month from history: ${peaks.topPeaks().map((kw) => kw.toFixed(2)).join(', ')} kW`);
    await this.replan();
  }

  // --- export at negative prices ------------------------------------------------------------

  /** Switches export off while selling costs money (Automatic mode), and back on afterwards. */
  private async updateExport(): Promise<void> {
    this.controller.exportControl = this.controlMode === 'auto' && this.canControl() && !this.powerCut.active
      && this.getSetting('negative_export_block') !== false;
    const change = await this.controller.applyExport(new Date(), this.planState);
    if (!change) return;
    this.log('Export:', change);
    await this.setStoreValue('exportBlockedByApp', this.controller.exportBlockedByApp);
    this.homey.api.realtime('live', null);
  }

  // --- power cuts ----------------------------------------------------------------------------

  private async updatePowerCut(live: LiveData): Promise<void> {
    const events = this.powerCut.update(live.timestamp, live.gridLost, this.backupHours(live));
    if (events.length === 0) return;
    await this.setStoreValue('powerCut', this.powerCut.toJSON());
    await this.setCapabilityValue('alarm_solis_power_cut', this.powerCut.active);
    for (const event of events) await this.onPowerCutEvent(event, live);
  }

  private async onPowerCutEvent(event: PowerCutEvent, live: LiveData): Promise<void> {
    const tz = this.homey.clock.getTimezone();
    const battery = Math.round(live.socPct);
    const hours = Math.round(this.backupHours(live) * 10) / 10;
    const notify = Boolean(this.getSetting('notify_power_cut') ?? true);
    this.log('Power cut event:', event, `battery ${battery} %, backup ${hours} h`);
    if (event === 'started') {
      await this.homey.flow.getDeviceTriggerCard('power_cut_started').trigger(this, { battery, backup_hours: hours }).catch(this.error);
      if (notify) await this.notify(this.homey.__('powerCut.started', { time: localHHMM(live.timestamp, tz), battery, hours: this.formatNumber(hours) }));
      // A save or charge slot must not hold the battery back while it powers the house.
      if (this.controlMode === 'auto') await this.controller.restoreInverter().catch(this.error);
    } else if (event === 'backup_low') {
      await this.homey.flow.getDeviceTriggerCard('backup_low').trigger(this, { battery, backup_hours: hours }).catch(this.error);
      if (notify) await this.notify(this.homey.__('powerCut.low', { battery, hours: this.formatNumber(hours) }));
    } else {
      const since = this.getStoreValue('powerCutStarted') as string | undefined;
      const minutes = since ? Math.round((live.timestamp.getTime() - new Date(since).getTime()) / 60_000) : 0;
      await this.homey.flow.getDeviceTriggerCard('power_cut_ended').trigger(this, { minutes, battery }).catch(this.error);
      if (notify) await this.notify(this.homey.__('powerCut.ended', { duration: this.formatDuration(minutes), battery }));
      this.homey.setTimeout(() => this.replan().catch(this.error), 1_000);
    }
    if (event === 'started') await this.setStoreValue('powerCutStarted', live.timestamp.toISOString());
  }

  // --- is the inverter following the plan? --------------------------------------------------

  /**
   * What the battery should be doing at a time (the sample's, so a sample from the end of a short
   * slot is judged against that slot), or null when the app does not control it then.
   */
  private expectation(at: Date): Expectation | null {
    const state = this.planState;
    if (!state || this.controlMode !== 'auto' || !this.canControl() || this.powerCut.active) return null;
    const ivs = state.plan.intervals;
    const index = ivs.findIndex((iv) => iv.start <= at && iv.end > at);
    if (index < 0) return null;
    const action = displayAction(ivs[index], state.reserveSoc);
    const same = (i: number) => displayAction(ivs[i], state.reserveSoc) === action;
    let start = index;
    while (start > 0 && same(start - 1)) start--;
    let end = index;
    while (end + 1 < ivs.length && same(end + 1)) end++;
    return {
      action,
      targetSoc: ivs[end].socEndPct,
      reserveSoc: state.reserveSoc,
      maxSoc: this.controller.config.maxSocPct,
      // Plans start at the current quarter, so a long period that began earlier counts from there.
      periodMinutes: (ivs[end].end.getTime() - ivs[start].start.getTime()) / 60_000,
      periodStart: ivs[start].start,
    };
  }

  private async checkPlan(): Promise<void> {
    const live = this.live;
    const sample = live && { time: live.timestamp, socPct: live.socPct, batteryW: live.batteryPowerW, gridW: live.gridPowerW };
    this.monitor.update(new Date(), sample, live ? this.expectation(live.timestamp) : null);
    // A locked battery has its own alarm and instructions.
    const planDeviation = this.monitor.deviation === 'not_covering_house' && this.lock.locked ? null : this.monitor.deviation;
    const settingIssue = exportSettingIssue(this.controller.lastRead, this.controller.exportBlockedByApp)
      ?? (this.throttle.throttled ? 'solar_throttled' : null);
    // A blocked grid charge explains "not charging" and says what to change, so it goes first.
    const deviation = settingIssue === 'grid_charge_blocked' ? settingIssue : planDeviation ?? settingIssue;
    if (deviation === this.offPlan) return;
    this.offPlan = deviation;
    await this.setCapabilityValue('alarm_solis_off_plan', deviation !== null);
    if (deviation) await this.reportOffPlan(this.deviationText(deviation));
    else await this.homey.flow.getDeviceTriggerCard('on_plan').trigger(this, {}).catch(this.error);
  }

  private async reportOffPlan(reason: string): Promise<void> {
    this.log('Off plan:', reason);
    await this.homey.flow.getDeviceTriggerCard('off_plan').trigger(this, { reason }).catch(this.error);
    if (this.getSetting('notify_off_plan') ?? true) await this.notify(this.homey.__('offPlan.notification', { reason }));
  }

  private deviationText(deviation: Deviation | ExportIssue): string {
    const since = this.live ? localHHMM(this.live.timestamp, this.homey.clock.getTimezone()) : '–';
    const limit = this.controller.lastRead?.exportLimitW ?? 0;
    return this.homey.__(`offPlan.${deviation}`, { time: since, limit: String(limit) });
  }

  /** The device's warning line: the most important current problem, if any. */
  private async refreshWarning(): Promise<void> {
    const tz = this.homey.clock.getTimezone();
    const floor = this.backupFloor();
    const reserve = this.planState?.reserveSoc;
    let text: string | null = null;
    if (this.powerCut.since) {
      text = this.homey.__('powerCut.warning', { time: localHHMM(this.powerCut.since, tz) });
    } else if (this.lock.locked) {
      text = this.lockWarning();
    } else if (this.planError) {
      text = `Planning failed: ${this.planError}`;
    } else if (this.offPlan) {
      text = this.deviationText(this.offPlan);
    } else if (!this.canControl()) {
      text = this.cannotControlText();
    } else if (reserve !== undefined && reserve <= floor + 2) {
      text = `Reserve ${reserve} % is not above the inverter's power-outage limit of ${floor} %: `
        + 'there is no backup energy. Raise the reserve in the settings.';
    }
    if (text) await this.setWarning(text);
    else await this.unsetWarning();
  }

  // --- formatting and notifications ----------------------------------------------------------

  private async notify(excerpt: string): Promise<void> {
    await this.homey.notifications.createNotification({ excerpt }).catch(this.error);
  }

  private currencySign(): string {
    return ({ SEK: 'kr', NOK: 'kr', DKK: 'kr', EUR: '€', PLN: 'zł' } as Record<string, string>)[this.currency] ?? this.currency;
  }

  private formatNumber(value: number): string {
    return value.toLocaleString(this.homey.i18n.getLanguage() === 'sv' ? 'sv-SE' : 'en-GB', { maximumFractionDigits: 1 });
  }

  private formatMoney(value: number): string {
    return value.toLocaleString(this.homey.i18n.getLanguage() === 'sv' ? 'sv-SE' : 'en-GB', { maximumFractionDigits: 0 });
  }

  private formatDuration(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h > 0 ? `${h} h ${m} min` : `${m} min`;
  }

  /** Publishes where the house's power comes from and what extra power costs, with flow triggers. */
  private async updateEnergyFlow(live: LiveData): Promise<void> {
    const previous = this.supply?.source;
    this.supply = houseSupply({ pvW: live.pvPowerW, loadW: live.loadPowerW, gridW: live.gridPowerW, batteryW: live.batteryPowerW });
    const s = this.supply;
    await Promise.all([
      this.setCapabilityValue('solis_power_source', s.source),
      this.setCapabilityValue('measure_solis_solar_share', s.solarPct),
      this.setCapabilityValue('measure_solis_battery_share', s.batteryPct),
      this.setCapabilityValue('measure_solis_grid_share', s.gridPct),
      this.setCapabilityValue('measure_solis_surplus', Math.round(s.surplusW)),
    ]);
    if (previous !== undefined && previous !== s.source) {
      await this.homey.flow.getDeviceTriggerCard('power_source_changed').trigger(this, {
        source: this.sourceTitle(s.source), solar_share: s.solarPct, battery_share: s.batteryPct, grid_share: s.gridPct,
      }).catch(this.error);
    }
    await this.updatePowerCost();
  }

  private async updatePowerCost(): Promise<void> {
    const cost = this.extraPowerCost();
    if (cost === null) return;
    const rounded = Math.round(cost * 100) / 100;
    await this.setCapabilityValue('measure_solis_power_cost', rounded);
    if (this.lastCostReported !== null && Math.abs(rounded - this.lastCostReported) >= 0.1) {
      await this.homey.flow.getDeviceTriggerCard('power_cost_changed').trigger(this, { cost: rounded }).catch(this.error);
    }
    if (this.lastCostReported === null || Math.abs(rounded - this.lastCostReported) >= 0.1) this.lastCostReported = rounded;
    await this.updatePowerLevel(cost);
  }

  private alternativeHeat(): AlternativeHeat {
    const s = this.getSettings() as Settings;
    return { costPerKwh: num(s.alt_heat_cost, 0), copAt7: num(s.hp_cop_7, 4), copAtMinus7: num(s.hp_cop_minus7, 2.6) };
  }

  /** The heat pump's efficiency depends on the outdoor temperature; only fetched when other heating is set up. */
  private async refreshOutdoorTemperature(): Promise<void> {
    if (!(this.alternativeHeat().costPerKwh > 0) || Date.now() - this.outdoorAt < 25 * 60_000) return;
    const latitude = this.homey.geolocation.getLatitude();
    const longitude = this.homey.geolocation.getLongitude();
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    this.outdoorC = await fetchOutdoorTemperature(latitude, longitude);
    this.outdoorAt = Date.now();
  }

  /** Cheap, normal or expensive now, and heat pump versus other heating; fires the flow trigger on a change. */
  private async updatePowerLevel(cost: number): Promise<void> {
    const s = this.getSettings() as Settings;
    const now = Date.now();
    const prices = (this.planState?.plan.intervals ?? [])
      .filter((iv) => iv.end.getTime() > now && iv.start.getTime() < now + 86_400_000)
      .map((iv) => iv.buy);
    const limits = levelLimits(prices, {
      mode: s.level_mode === 'manual' ? 'manual' : 'auto',
      sharePct: num(s.level_share, 25),
      cheapBelow: num(s.level_cheap, 1),
      expensiveAbove: num(s.level_expensive, 2.5),
    });
    if (!limits) return;
    const level = powerLevel(cost, limits, this.level);
    this.breakEven = breakEvenCost(this.outdoorC, this.alternativeHeat());
    const other = alternativeCheaper(cost, this.breakEven, this.otherHeating);
    this.levelLimits = limits;
    const changed = level !== this.level || other !== this.otherHeating;
    this.level = level;
    this.otherHeating = other;
    if (this.hasCapability('solis_power_level')) await this.setCapabilityValue('solis_power_level', level).catch(this.error);
    if (!changed) return;
    const round2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
    this.log(`Extra power ${level} at ${round2(cost)} (cheap ≤ ${round2(limits.cheapBelow)}, expensive ≥ ${round2(limits.expensiveAbove)})`
      + (this.breakEven === null ? '' : `, other heating cheaper above ${round2(this.breakEven)}: ${other}`));
    await this.homey.flow.getDeviceTriggerCard('power_level_changed').trigger(this, {
      level: this.homey.__(`powerLevel.${level}`),
      cost: round2(cost),
      cheap_limit: round2(limits.cheapBelow),
      expensive_limit: round2(limits.expensiveAbove),
      other_heating_cheaper: other,
    }).catch(this.error);
  }

  private sourceTitle(source: string): string {
    const sv = this.homey.i18n.getLanguage() === 'sv';
    const names: Record<string, [string, string]> = {
      solar: ['Solar', 'Sol'], solar_battery: ['Solar + battery', 'Sol + batteri'], battery: ['Battery', 'Batteri'],
      grid: ['Grid', 'Nät'], solar_grid: ['Solar + grid', 'Sol + nät'], battery_grid: ['Battery + grid', 'Batteri + nät'],
      solar_battery_grid: ['Solar + battery + grid', 'Sol + batteri + nät'], none: ['Nothing', 'Inget'],
    };
    return (names[source] ?? [source, source])[sv ? 1 : 0];
  }

  /** Warns when a leftover remote command (e.g. SolisCloud Quick Control) keeps the battery frozen at 0 A. */
  private async updateLock(live: LiveData): Promise<void> {
    const reserve = this.planState?.reserveSoc ?? this.controller.reserveSocAt(new Date());
    const changed = this.lock.update({
      time: live.timestamp,
      remoteEnabled: live.remoteControlEnabled,
      remoteCurrentA: live.remoteCurrentLimitA,
      socPct: live.socPct,
      gridW: live.gridPowerW,
      batteryW: live.batteryPowerW,
    }, reserve, this.controlMode === 'auto' && this.currentAction() === 'hold');
    await this.setCapabilityValue('alarm_solis_battery_locked', this.lock.locked);
    if (!changed) return;
    this.log(this.lock.locked ? 'Battery locked by a remote command' : 'Battery released');
    await this.homey.flow.getDeviceTriggerCard(this.lock.locked ? 'battery_locked' : 'battery_unlocked')
      .trigger(this, {}).catch(this.error);
  }

  /**
   * Bootstraps the load profile, the solar calibration and the weather models' scores from the
   * connection's history (e.g. SolisCloud's 5-minute data), so planning uses the real consumption
   * pattern and solar behaviour from day one. The models' scores are learned on their own when new.
   */
  private async learnFromHistory(): Promise<void> {
    if (!this.transport.getHistory) return;
    const learnAll = !this.getStoreValue('historyLearned');
    const solar = this.solar?.provider.hasHistory ? this.solar : null;
    const learnSkill = Boolean(solar) && !this.getStoreValue('skillLearned');
    if (!learnAll && !learnSkill) return;
    const tz = this.homey.clock.getTimezone();
    const load = new LoadProfile(tz);
    await solar?.refresh(HISTORY_DAYS).catch(this.error);
    const quarters: Array<[Date, number]> = [];
    const pv = new QuarterAverager((start, kw) => quarters.push([start, kw]));
    for (let d = HISTORY_DAYS; d >= 1; d--) {
      const date = localDate(addDays(new Date(), -d), tz);
      try {
        for (const sample of await this.transport.getHistory(date, tz)) {
          load.addSample(sample.time, sample.loadW / 1000);
          const curtailed = looksCurtailed(sample.pvW / 1000, sample.loadW / 1000, sample.gridW / 1000, sample.batteryW / 1000);
          pv.add(sample.time, curtailed ? NaN : sample.pvW / 1000);
        }
      } catch (err) {
        this.error(`History for ${date} failed:`, err);
      }
    }
    load.flush();
    if (load.observations < 96) return; // not enough data; try again at the next start
    if (solar) {
      // First the calibration (shading, orientation), then score the models against it.
      if (learnAll) for (const [start, kw] of quarters) solar.learn(start, kw, { skill: false });
      if (learnSkill) for (const [start, kw] of quarters) solar.learn(start, kw, { calibration: false });
      await this.setStoreValue('solarCalibration', solar.calibration.toJSON());
      await this.setStoreValue('solarSkill', solar.skill.toJSON());
      await this.setStoreValue('skillLearned', true);
      this.log('Weather model weights:', solar.describeWeights() ?? 'still learning');
    }
    if (learnAll) {
      this.loadProfile = new LoadProfile(tz, load.toJSON());
      await this.setStoreValue('loadProfile', this.loadProfile.toJSON());
      await this.setStoreValue('historyLearned', true);
      this.log(`Learned from ${HISTORY_DAYS} days of history: ${load.observations} load quarters, `
        + `${solar?.calibration.observations ?? 0} solar quarters`);
    }
    await this.solar?.refresh().catch(this.error); // recombine the models with the new weights
    await this.replan();
  }

  private backupFloor(): number {
    return this.offGridFloorSoc ?? (this.getStoreValue('offGridFloorSoc') as number | undefined) ?? 30;
  }

  /** Energy above the inverter's off-grid floor divided by the current house load. */
  private backupHours(live: LiveData): number {
    const energyKwh = Math.max(0, live.socPct - this.backupFloor()) / 100 * this.controller.config.capacityKwh;
    const loadKw = Math.max(live.loadPowerW / 1000, Number.isFinite(live.backupLoadW) ? live.backupLoadW / 1000 : 0, 0.3);
    return Math.min(99, energyKwh / loadKw);
  }

  private async updateWarnings(now: Date): Promise<void> {
    const s = this.getSettings() as Settings;
    const previousIds = new Set(this.warnings.map((w) => w.id));
    if (s.warnings_enabled) {
      const language = this.homey.i18n.getLanguage() === 'sv' ? 'sv' : 'en';
      const fetcher = s.warnings_source === 'metno' ? fetchMetNoWarnings : fetchWarnings;
      this.warnings = await fetcher(this.homey.geolocation.getLatitude(), this.homey.geolocation.getLongitude(), now, {
        minLevel: s.warnings_min_level as WarningLevel,
        weatherOnly: Boolean(s.warnings_weather_only),
        leadHours: Number(s.warnings_lead_hours),
      }, language);
    } else {
      this.warnings = [];
    }

    const dismissed = new Set((this.getStoreValue('dismissedWarnings') as string[] | undefined) ?? []);
    const relevant = this.warnings.filter((w) => !dismissed.has(w.id));
    if (relevant.length > 0) {
      const until = relevant
        .map((w) => w.end ?? addMinutes(now, OUTAGE_HOURS_WITHOUT_END * 60))
        .reduce((a, b) => (a > b ? a : b));
      this.controller.outage = { targetSoc: Number(s.outage_target), until };
    }

    const tz = this.homey.clock.getTimezone();
    for (const w of this.warnings.filter((x) => !previousIds.has(x.id))) {
      await this.homey.flow.getDeviceTriggerCard('weather_warning_started').trigger(this, {
        level: w.level,
        title: w.title,
        area: w.areaName,
        until: w.end ? localHHMM(w.end, tz) : '',
      }).catch(this.error);
    }
    if (previousIds.size > 0 && this.warnings.length === 0) {
      await this.homey.flow.getDeviceTriggerCard('weather_warning_ended').trigger(this, {}).catch(this.error);
    }
    await this.setCapabilityValue('alarm_solis_weather', this.warnings.length > 0);
    await this.setCapabilityValue('solis_warning', this.warnings.length > 0
      ? this.warnings.map((w) => `${w.title} (${w.areaName})`).join(' · ')
      : '–');
  }

  /** Follows planned grid charging that does not start, and tells the brand how long it has been. */
  private async checkGridCharge(): Promise<void> {
    if (this.planning) return; // not while the plan is being written to the inverter
    const live = this.live;
    const e = live ? this.expectation(live.timestamp) : null;
    const stalled = live && e?.action === 'charge' && e.periodStart && live.gridLost !== true
      && live.batteryPowerW < 300 && live.socPct < Math.min(e.targetSoc, e.maxSoc) - 2;
    if (!stalled || !live || !e?.periodStart) {
      this.chargeStall = null;
      return;
    }
    const period = e.periodStart.getTime();
    if (this.chargeStall?.period !== period) this.chargeStall = { period, since: live.timestamp.getTime() };
    const minutes = (live.timestamp.getTime() - this.chargeStall.since) / 60_000;
    if (minutes > 0) await this.onGridChargeStalled(minutes, e.periodStart);
  }

  private async replan(): Promise<void> {
    if (this.planning || !this.live) return;
    if (this.inverterBusy) {
      this.homey.setTimeout(() => this.replan().catch(this.error), 10_000);
      return;
    }
    this.planning = true;
    try {
      const now = new Date();
      await this.updateWarnings(now).catch((err) => this.error('Weather warnings failed:', err));
      await this.solar?.refresh().catch((err) => this.error('Solar forecast failed:', err));
      await this.refreshOutdoorTemperature().catch((err) => this.error('Outdoor temperature failed:', err));
      await this.updateSolarCapability(now);

      this.controller.exportControl = this.controlMode === 'auto' && this.canControl() && !this.powerCut.active
        && this.getSetting('negative_export_block') !== false;
      const state = await this.controller.buildPlan(this.live, now);
      this.planState = state;
      this.history.setDayPlan(now, state.plan.intervals);
      await this.updatePlanCapabilities(state, now);
      await this.updatePowerCost();

      if (this.controlMode !== 'auto' || !this.canControl()) await this.readInverterLimits().catch(this.error);
      if (this.controlMode === 'auto' && this.canControl() && !this.powerCut.active) {
        const changes = await this.controller.apply(state);
        if (changes.length > 0) this.log('Inverter updated:', changes.join('; '));
        if (this.controller.externalChange && changes.length > 0) await this.reportOffPlan(this.homey.__('offPlan.settings_changed'));
      }
      this.planError = null;
      await this.refreshWarning();
      await this.homey.flow.getDeviceTriggerCard('plan_updated')
        .trigger(this, { summary: this.summarise(state), savings: Math.round(state.plan.savingsSek * 100) / 100 })
        .catch(this.error);
      this.homey.api.realtime('plan', null);
      await this.publishDashboard();
    } catch (err) {
      this.error('Planning failed:', err);
      this.planError = (err as Error).message;
      await this.refreshWarning().catch(this.error);
    } finally {
      this.planning = false;
    }
  }

  /** Expected PV energy for the whole local day. */
  private async updateSolarCapability(now: Date): Promise<void> {
    if (!this.solar) return;
    const weights = this.solar.models.length > 1
      ? this.solar.describeWeights() ?? this.homey.__('device.weightsLearning')
      : '–';
    if (this.getSetting('pv_model_weights') !== weights) await this.setSettings({ pv_model_weights: weights }).catch(this.error);
    const tz = this.homey.clock.getTimezone();
    const today = localDate(now, tz);
    let kwh = 0;
    for (let t = now.getTime() - 86_400_000; t < now.getTime() + 86_400_000; t += 900_000) {
      const time = new Date(Math.floor(t / 900_000) * 900_000);
      if (localDate(time, tz) === today) kwh += (this.solar.forecastAt(time) ?? 0) / 4;
    }
    await this.setCapabilityValue('measure_solis_pv_forecast', Math.round(kwh * 10) / 10);
  }

  private async updatePlanCapabilities(state: PlanState, now: Date): Promise<void> {
    const current = state.plan.intervals.find((iv) => iv.start <= now && iv.end > now);
    if (current) await this.setCapabilityValue('measure_solis_price', current.buy);
    await this.setCapabilityValue('measure_solis_reserve', state.reserveSoc);
    await this.setCapabilityValue('solis_plan_status', this.summarise(state));

    const action = current?.action ?? null;
    if (action && action !== this.lastAction) {
      if (this.lastAction !== null) {
        await this.homey.flow.getDeviceTriggerCard('action_changed').trigger(this, { action }).catch(this.error);
      }
      this.lastAction = action;
    }
  }

  private summarise(state: PlanState): string {
    const language = this.homey.i18n.getLanguage() === 'sv' ? 'sv' : 'en';
    const live = this.live && { socPct: this.live.socPct, batteryW: this.live.batteryPowerW, gridW: this.live.gridPowerW };
    return planSummary(state.plan.intervals, new Date(), state.reserveSoc, this.controller.config.maxSocPct,
      this.homey.clock.getTimezone(), language, live ?? undefined);
  }
}
