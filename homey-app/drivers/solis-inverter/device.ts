import Homey from 'homey';

import { BatteryController, type ControllerConfig, currentAction, type PlanState } from '../../lib/controller/BatteryController.js';
import { LoadProfile, type LoadProfileData } from '../../lib/forecast/LoadProfile.js';
import { type CalibrationData, SolarCalibration, SolarForecaster } from '../../lib/forecast/SolarForecast.js';
import type { InverterTransport, LiveData } from '../../lib/inverter/types.js';
import type { BatteryAction } from '../../lib/planner/planner.js';
import { ElprisetJustNuProvider, type PriceArea } from '../../lib/prices/PriceProvider.js';
import { SolisCloudTransport } from '../../lib/solis/SolisCloudTransport.js';
import { addDays, addMinutes, localDate, localHHMM } from '../../lib/time.js';
import { fetchWarnings, type WarningLevel, type WeatherWarning } from '../../lib/warnings/SmhiWarnings.js';

type ControlMode = 'monitor' | 'auto';
type Settings = Record<string, number | string | boolean>;

const LIVE_INTERVAL_MS = 5 * 60_000;
const PLAN_INTERVAL_MS = 30 * 60_000;
const HISTORY_DAYS = 14;
const OUTAGE_HOURS_WITHOUT_END = 24;

const prices = new ElprisetJustNuProvider();

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

export default class SolisInverterDevice extends Homey.Device {
  private transport!: InverterTransport;
  private controller!: BatteryController;
  private loadProfile!: LoadProfile;
  private solar: SolarForecaster | null = null;
  private pvQuarters!: QuarterAverager;
  private live: LiveData | null = null;
  private planState: PlanState | null = null;
  private warnings: WeatherWarning[] = [];
  private lastAction: BatteryAction | null = null;
  private lastSampleTime = 0;
  private planning = false;

  override async onInit(): Promise<void> {
    const tz = this.homey.clock.getTimezone();
    this.loadProfile = new LoadProfile(tz, this.getStoreValue('loadProfile') as LoadProfileData | undefined);
    this.pvQuarters = new QuarterAverager((start, kw) => {
      if (!this.solar) return;
      this.solar.learn(start, kw);
      this.setStoreValue('solarCalibration', this.solar.calibration.toJSON()).catch(this.error);
    });
    await this.migrateCapabilities();
    this.createController();

    if (!this.getCapabilityValue('solis_control_mode')) {
      // Start passive: the SolisCloud EMS must be switched off before this app takes control.
      await this.setCapabilityValue('solis_control_mode', 'monitor');
    }
    this.registerCapabilityListener('solis_control_mode', async (mode: ControlMode) => {
      this.log('Control mode →', mode);
      this.homey.setTimeout(() => this.replan().catch(this.error), 1_000);
    });

    this.homey.setInterval(() => this.refreshLive().catch(this.error), LIVE_INTERVAL_MS);
    this.homey.setInterval(() => this.replan().catch(this.error), PLAN_INTERVAL_MS);
    await this.refreshLive().catch(this.error);
    await this.replan().catch(this.error);
    this.learnFromHistory().catch(this.error);
  }

  override async onSettings({ changedKeys }: { changedKeys: string[] }): Promise<void> {
    this.log('Settings changed:', changedKeys);
    const solarChanged = changedKeys.some((k) => k.startsWith('pv_array'));
    this.homey.setTimeout(async () => {
      if (solarChanged) {
        // New orientation: the previous calibration no longer applies.
        await this.unsetStoreValue('solarCalibration').catch(this.error);
        await this.unsetStoreValue('historyLearned').catch(this.error);
      }
      this.createController();
      await this.replan().catch(this.error);
      if (solarChanged) this.learnFromHistory().catch(this.error);
    }, 500);
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
    await this.setCapabilityValue('solis_control_mode', mode);
    await this.replan();
  }

  async addOverride(action: 'charge' | 'hold', minutes: number): Promise<void> {
    const now = new Date();
    this.controller.overrides.push({ action, from: now, until: addMinutes(now, minutes) });
    await this.replan();
  }

  async prepareOutage(hours: number): Promise<void> {
    this.controller.outage = { targetSoc: Number(this.getSetting('outage_target')), until: addMinutes(new Date(), hours * 60) };
    await this.replan();
  }

  async clearOverrides(): Promise<void> {
    this.controller.overrides = [];
    this.controller.outage = null;
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

  currentAction(): BatteryAction | null {
    return currentAction(this.planState, new Date());
  }

  hasWeatherWarning(): boolean {
    return this.warnings.length > 0;
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

  /** Data for the dashboard widgets. */
  getView(): unknown {
    const state = this.planState;
    const live = this.live;
    const round = (v: number, d = 0) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
    return {
      ready: Boolean(state),
      timeZone: this.homey.clock.getTimezone(),
      language: this.homey.i18n.getLanguage(),
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
      plan: state && {
        generatedAt: state.generatedAt.toISOString(),
        reserveSoc: state.reserveSoc,
        savingsSek: round(state.plan.savingsSek, 1),
        warnings: state.schedule.warnings,
        slots: state.schedule.chargeSlots.filter((s) => s.enabled),
        learnedLoad: this.loadProfile.observations >= 96 * 3,
        solarForecast: Boolean(this.solar),
        intervals: state.plan.intervals.map((iv) => ({
          t: iv.start.toISOString(),
          price: round(iv.buy, 3),
          action: iv.action,
          soc: round(iv.socEndPct, 1),
          loadKw: round(this.loadProfile.predict(iv.start) ?? this.controller.config.avgLoadKw, 2),
          pvKw: round(this.solar?.forecastAt(iv.start) ?? 0, 2),
        })),
      },
    };
  }

  // --- internals -----------------------------------------------------------------------------

  /** Capabilities were renamed during development; keep existing devices in line with the driver. */
  private async migrateCapabilities(): Promise<void> {
    const wanted = (this.driver.manifest as { capabilities: string[] }).capabilities;
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
    this.transport = new SolisCloudTransport({ keyId: String(s.key_id), keySecret: String(s.key_secret) }, id);
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
        this.solar = new SolarForecaster({ latitude, longitude, arrays, performanceRatio: 0.85, maxAcKw: 20 }, calibration);
      }
    }

    const previous = this.controller;
    this.controller = new BatteryController(this.transport, prices, config, (...args) => this.log(...args));
    this.controller.loadForecast = (time) => this.loadProfile.predict(time);
    this.controller.pvForecast = (time) => this.solar?.forecastAt(time) ?? null;
    if (previous) {
      this.controller.overrides = previous.overrides;
      this.controller.outage = previous.outage;
    }
  }

  private async refreshLive(): Promise<void> {
    try {
      const live = await this.transport.getLiveData();
      this.live = live;
      if (live.timestamp.getTime() > this.lastSampleTime) {
        this.lastSampleTime = live.timestamp.getTime();
        this.loadProfile.addSample(live.timestamp, live.loadPowerW / 1000);
        this.pvQuarters.add(live.timestamp, live.pvPowerW / 1000);
        await this.setStoreValue('loadProfile', this.loadProfile.toJSON());
      }
      await this.setAvailable();
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
    } catch (err) {
      this.error('Live data failed:', err);
      if (!this.live) await this.setUnavailable(`SolisCloud: ${(err as Error).message}`);
    }
  }

  /**
   * Bootstraps the load profile and solar calibration from SolisCloud's 5-minute history, so
   * planning uses the real consumption pattern and solar behaviour from day one.
   */
  private async learnFromHistory(): Promise<void> {
    if (!this.transport.getHistory || this.getStoreValue('historyLearned')) return;
    const tz = this.homey.clock.getTimezone();
    const load = new LoadProfile(tz);
    await this.solar?.refresh(HISTORY_DAYS).catch(this.error);
    const pv = new QuarterAverager((start, kw) => this.solar?.learn(start, kw));
    for (let d = HISTORY_DAYS; d >= 1; d--) {
      const date = localDate(addDays(new Date(), -d), tz);
      try {
        for (const sample of await this.transport.getHistory(date, tz)) {
          load.addSample(sample.time, sample.loadW / 1000);
          pv.add(sample.time, sample.pvW / 1000);
        }
      } catch (err) {
        this.error(`History for ${date} failed:`, err);
      }
    }
    load.flush();
    if (load.observations < 96) return; // not enough data; try again at the next start
    this.loadProfile = new LoadProfile(tz, load.toJSON());
    await this.setStoreValue('loadProfile', this.loadProfile.toJSON());
    if (this.solar) await this.setStoreValue('solarCalibration', this.solar.calibration.toJSON());
    await this.setStoreValue('historyLearned', true);
    this.log(`Learned from ${HISTORY_DAYS} days of history: ${load.observations} load quarters, `
      + `${this.solar?.calibration.observations ?? 0} solar quarters`);
    await this.replan();
  }

  /** Energy above the over-discharge floor divided by the current house load. */
  private backupHours(live: LiveData): number {
    const floor = 15; // TODO: read the off-grid over-discharge SOC from the inverter
    const energyKwh = Math.max(0, live.socPct - floor) / 100 * this.controller.config.capacityKwh;
    const loadKw = Math.max(live.loadPowerW / 1000, 0.3);
    return Math.min(99, energyKwh / loadKw);
  }

  private async updateWarnings(now: Date): Promise<void> {
    const s = this.getSettings() as Settings;
    const previousIds = new Set(this.warnings.map((w) => w.id));
    if (s.warnings_enabled) {
      const language = this.homey.i18n.getLanguage() === 'sv' ? 'sv' : 'en';
      this.warnings = await fetchWarnings(this.homey.geolocation.getLatitude(), this.homey.geolocation.getLongitude(), now, {
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

  private async replan(): Promise<void> {
    if (this.planning || !this.live) return;
    this.planning = true;
    try {
      const now = new Date();
      await this.updateWarnings(now).catch((err) => this.error('SMHI warnings failed:', err));
      await this.solar?.refresh().catch((err) => this.error('Solar forecast failed:', err));
      await this.updateSolarCapability(now);

      const state = await this.controller.buildPlan(this.live, now);
      this.planState = state;
      await this.updatePlanCapabilities(state, now);

      if (this.controlMode === 'auto') {
        const changes = await this.controller.apply(state);
        if (changes.length > 0) this.log('Inverter updated:', changes.join('; '));
      }
      await this.unsetWarning();
      await this.homey.flow.getDeviceTriggerCard('plan_updated')
        .trigger(this, { summary: this.summarise(state), savings: Math.round(state.plan.savingsSek * 100) / 100 })
        .catch(this.error);
      this.homey.api.realtime('plan', null);
    } catch (err) {
      this.error('Planning failed:', err);
      await this.setWarning(`Planning failed: ${(err as Error).message}`).catch(this.error);
    } finally {
      this.planning = false;
    }
  }

  /** Expected PV energy for the whole local day. */
  private async updateSolarCapability(now: Date): Promise<void> {
    if (!this.solar) return;
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
    const tz = this.homey.clock.getTimezone();
    const slots = state.schedule.chargeSlots.filter((s) => s.enabled);
    const suffix = this.controlMode === 'auto' ? '' : ' (monitor)';
    if (slots.length === 0) return `Self-use, no grid charging planned${suffix}`;
    const parts = slots.map((s) => `${s.currentA > 0 ? 'Charge' : 'Hold'} ${s.start}–${s.end}`);
    return `${parts.join(', ')}${suffix} · ${localHHMM(state.generatedAt, tz)}`;
  }
}
