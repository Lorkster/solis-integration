import type { BatteryAction } from '../planner/planner.js';

/**
 * Checks that the inverter does what the plan says. Cloud data arrives every ~5 minutes and the
 * inverter reacts with some delay, so a deviation is only reported when it lasts.
 */
export type Deviation =
  | 'not_charging' // planned grid charging, battery not charging
  | 'discharging_while_saving' // planned save, battery discharging
  | 'not_covering_house' // self-use above reserve, grid powers the house, battery idle
  | 'unplanned_grid_charging' // self-use, battery charging while the house also imports
  | 'no_data'; // no fresh data from the inverter

export interface MonitorSample {
  time: Date; // when the inverter sampled the data
  socPct: number;
  batteryW: number; // positive = charging
  gridW: number; // positive = import
}

export interface Expectation {
  action: BatteryAction;
  targetSoc: number; // charge: SOC the slot charges to
  reserveSoc: number;
  maxSoc: number;
}

const W = 300; // battery power that counts as moving

/** Deviation shown by one sample, or null when it is consistent with the plan. */
export function deviationOf(s: MonitorSample, e: Expectation): Deviation | null {
  if (e.action === 'charge') {
    const full = s.socPct >= Math.min(e.targetSoc, e.maxSoc) - 2;
    return !full && s.batteryW < W ? 'not_charging' : null;
  }
  if (e.action === 'hold') return s.batteryW < -W ? 'discharging_while_saving' : null;
  if (s.batteryW > 500 && s.gridW > 500 && s.socPct < e.maxSoc - 2) return 'unplanned_grid_charging';
  if (s.socPct > e.reserveSoc + 3 && s.gridW > 500 && s.batteryW > -100) return 'not_covering_house';
  return null;
}

export class PlanMonitor {
  deviation: Deviation | null = null;
  private candidate: Deviation | null = null;
  private candidateSince = 0;
  private okSince = 0;

  constructor(private readonly minMinutes = 20, private readonly staleMinutes = 20) {}

  /**
   * Feeds the latest data (repeated samples are fine). `expectation` is null when the plan is not
   * being applied (monitor mode), so only missing data is checked. Returns true when the reported
   * deviation changed.
   */
  update(now: Date, sample: MonitorSample | null, expectation: Expectation | null): boolean {
    const previous = this.deviation;
    const stale = !sample || now.getTime() - sample.time.getTime() > this.staleMinutes * 60_000;
    if (stale) {
      this.deviation = 'no_data';
    } else {
      const seen = expectation ? deviationOf(sample, expectation) : null;
      const t = sample.time.getTime();
      if (seen) {
        if (seen !== this.candidate) {
          this.candidate = seen;
          this.candidateSince = t;
        }
        this.okSince = 0;
        if (this.deviation === 'no_data') this.deviation = null;
        if (t - this.candidateSince >= this.minMinutes * 60_000) this.deviation = seen;
      } else {
        this.candidate = null;
        this.okSince ||= t;
        // Clear once the data has been consistent for a while (or at once if the data came back).
        if (this.deviation === 'no_data' || t - this.okSince >= 10 * 60_000 || !expectation) this.deviation = null;
      }
    }
    return this.deviation !== previous;
  }
}
