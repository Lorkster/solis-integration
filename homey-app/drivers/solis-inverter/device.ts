import Homey from 'homey';

import { LoadProfile, type LoadProfileData } from '../../lib/forecast/LoadProfile.js';
import { BatteryController, type ControllerConfig, currentAction, type PlanState } from '../../lib/controller/BatteryController.js';
import type { InverterTransport, LiveData } from '../../lib/inverter/types.js';
import type { BatteryAction } from '../../lib/planner/planner.js';
import { ElprisetJustNuProvider, type PriceArea } from '../../lib/prices/PriceProvider.js';
import { SolisCloudTransport } from '../../lib/solis/SolisCloudTransport.js';
import { addDays, addMinutes, localDate, localHHMM } from '../../lib/time.js';

type ControlMode = 'monitor' | 'auto';

const LIVE_INTERVAL_MS = 5 * 60_000;
const PLAN_INTERVAL_MS = 30 * 60_000;
const HISTORY_DAYS = 14;

const prices = new ElprisetJustNuProvider();

export default class SolisInverterDevice extends Homey.Device {
  private transport!: InverterTransport;
  private controller!: BatteryController;
  private live: LiveData | null = null;
  private planState: PlanState | null = null;
  private lastAction: BatteryAction | null = null;
  private planning = false;
  private loadProfile!: LoadProfile;
  private lastSampleTime = 0;

  override async onInit(): Promise<void> {
    this.loadProfile = new LoadProfile(this.homey.clock.getTimezone(), this.getStoreValue('loadProfile') as LoadProfileData | undefined);
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
    this.homey.setTimeout(() => {
      this.createController();
      this.replan().catch(this.error);
    }, 500);
  }

  // --- used by flow cards and the widget -------------------------------------------------

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
    this.controller.outage = {
      targetSoc: Number(this.getSetting('outage_target')),
      until: addMinutes(new Date(), hours * 60),
    };
    await this.replan();
  }

  async clearOverrides(): Promise<void> {
    this.controller.overrides = [];
    this.controller.outage = null;
    await this.replan();
  }

  currentAction(): BatteryAction | null {
    return currentAction(this.planState, new Date());
  }

  isPriceAmongCheapest(hours: number): boolean {
    const now = new Date();
    const tz = this.homey.clock.getTimezone();
    const today = localDate(now, tz);
    const intervals = (this.planState?.plan.intervals ?? []).filter((iv) => localDate(iv.start, tz) === today);
    const current = intervals.find((iv) => iv.start <= now && iv.end > now);
    if (!current) return false;
    const quarters = Math.round(hours * 4);
    const cheapest = [...intervals].sort((a, b) => a.buy - b.buy).slice(0, quarters);
    return cheapest.includes(current);
  }

  getPlanView(): unknown {
    const state = this.planState;
    if (!state) return { ready: false };
    const tz = this.homey.clock.getTimezone();
    return {
      ready: true,
      generatedAt: state.generatedAt.toISOString(),
      timeZone: tz,
      controlMode: this.controlMode,
      reserveSoc: state.reserveSoc,
      loadProfileObservations: this.loadProfile.observations,
      socPct: this.live?.socPct ?? null,
      savingsSek: Math.round(state.plan.savingsSek * 100) / 100,
      warnings: state.schedule.warnings,
      slots: state.schedule.chargeSlots.filter((s) => s.enabled),
      intervals: state.plan.intervals.map((iv) => ({
        start: iv.start.toISOString(),
        buy: Math.round(iv.buy * 1000) / 1000,
        action: iv.action,
        soc: Math.round(iv.socEndPct),
      })),
    };
  }

  // --- internals ---------------------------------------------------------------------------

  private createController(): void {
    const s = this.getSettings() as Record<string, number | string | boolean>;
    const { id } = this.getData() as { id: string };
    this.transport = new SolisCloudTransport({ keyId: String(s.key_id), keySecret: String(s.key_secret) }, id);
    const config: ControllerConfig = {
      timeZone: this.homey.clock.getTimezone(),
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
    };
    const previous = this.controller;
    this.controller = new BatteryController(this.transport, prices, config, (...args) => this.log(...args));
    this.controller.loadForecast = (time) => this.loadProfile.predict(time);
    if (previous) {
      this.controller.overrides = previous.overrides;
      this.controller.outage = previous.outage;
    }
  }

  private async refreshLive(): Promise<void> {
    try {
      const live = await this.transport.getLiveData();
      this.live = live;
      if (live.timestamp.getTime() > this.lastSampleTime && Number.isFinite(live.loadPowerW)) {
        this.lastSampleTime = live.timestamp.getTime();
        this.loadProfile.addSample(live.timestamp, live.loadPowerW / 1000);
        await this.setStoreValue('loadProfile', this.loadProfile.toJSON());
      }
      await this.setAvailable();
      const set = (cap: string, value: number) => (Number.isFinite(value) ? this.setCapabilityValue(cap, value) : undefined);
      await Promise.all([
        set('measure_battery', live.socPct),
        set('measure_power', live.batteryPowerW),
        set('meter_power.charged', live.batteryChargedTotalKwh),
        set('meter_power.discharged', live.batteryDischargedTotalKwh),
        set('solis_pv_power', live.pvPowerW),
        set('solis_grid_power', live.gridPowerW),
        set('solis_load_power', live.loadPowerW),
        set('solis_backup_hours', this.backupHours(live)),
      ]);
    } catch (err) {
      this.error('Live data failed:', err);
      if (!this.live) await this.setUnavailable(`SolisCloud: ${(err as Error).message}`);
    }
  }

  /**
   * Bootstraps the load profile from SolisCloud's 5-minute history so planning uses the real
   * consumption pattern from day one instead of a flat average.
   */
  private async learnFromHistory(): Promise<void> {
    if (!this.transport.getHistory || this.getStoreValue('historyLearned')) return;
    const tz = this.homey.clock.getTimezone();
    const history = new LoadProfile(tz);
    for (let d = HISTORY_DAYS; d >= 1; d--) {
      const date = localDate(addDays(new Date(), -d), tz);
      try {
        for (const sample of await this.transport.getHistory(date, tz)) history.addSample(sample.time, sample.loadW / 1000);
      } catch (err) {
        this.error(`History for ${date} failed:`, err);
      }
    }
    history.flush();
    if (history.observations < 96) return; // not enough data, try again next start
    this.loadProfile = new LoadProfile(tz, history.toJSON());
    await this.setStoreValue('loadProfile', this.loadProfile.toJSON());
    await this.setStoreValue('historyLearned', true);
    this.log(`Load profile learned from ${HISTORY_DAYS} days of history (${history.observations} quarters)`);
    await this.replan();
  }

  /** Energy above the over-discharge floor divided by the current house load. */
  private backupHours(live: LiveData): number {
    const floor = 15; // TODO: read the off-grid over-discharge SOC from the inverter
    const energyKwh = Math.max(0, live.socPct - floor) / 100 * this.controller.config.capacityKwh;
    const loadKw = Math.max(live.loadPowerW / 1000, 0.3);
    return Math.min(99, energyKwh / loadKw);
  }

  private async replan(): Promise<void> {
    if (this.planning || !this.live) return;
    this.planning = true;
    try {
      const now = new Date();
      const state = await this.controller.buildPlan(this.live, now);
      this.planState = state;
      await this.updatePlanCapabilities(state, now);

      if (this.controlMode === 'auto') {
        const changes = await this.controller.apply(state);
        if (changes.length > 0) this.log('Inverter updated:', changes.join('; '));
      }
      await this.unsetWarning();
      const summary = this.summarise(state);
      await this.homey.flow.getDeviceTriggerCard('plan_updated')
        .trigger(this, { summary, savings: Math.round(state.plan.savingsSek * 100) / 100 })
        .catch(this.error);
    } catch (err) {
      this.error('Planning failed:', err);
      await this.setWarning(`Planning failed: ${(err as Error).message}`).catch(this.error);
    } finally {
      this.planning = false;
    }
  }

  private async updatePlanCapabilities(state: PlanState, now: Date): Promise<void> {
    const current = state.plan.intervals.find((iv) => iv.start <= now && iv.end > now);
    if (current) await this.setCapabilityValue('solis_price', current.buy);
    await this.setCapabilityValue('solis_reserve_soc', state.reserveSoc);
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
    const next = state.schedule.chargeSlots.filter((s) => s.enabled);
    const mode = this.controlMode === 'auto' ? '' : ' (monitor)';
    if (next.length === 0) return `Self-use, no grid charging planned${mode}`;
    const parts = next.map((s) => `${s.currentA > 0 ? 'Charge' : 'Hold'} ${s.start}–${s.end}`);
    return `${parts.join(', ')}${mode} · updated ${localHHMM(state.generatedAt, tz)}`;
  }
}
