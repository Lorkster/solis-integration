import { localParts } from '../time.js';

const SLOTS = 96; // quarter hours per day

export interface LoadProfileData {
  version: 1;
  weekday: number[]; // kW per quarter hour
  weekend: number[];
  weekdayCount: number[]; // quarters observed per slot (saturates)
  weekendCount: number[];
}

/**
 * Typical house load per quarter hour of the day, learned from observed consumption.
 * Weekdays and weekends are learned separately. Each observed quarter updates its slot with an
 * exponential moving average, so the profile follows seasonal change (heating) within about a week.
 */
export class LoadProfile {
  private data: LoadProfileData;
  private pending: { key: string; sum: number; n: number; date: Date } | null = null;

  constructor(
    private readonly timeZone: string,
    data?: LoadProfileData,
    private readonly alpha = 0.2,
    private readonly minObservations = 3,
  ) {
    this.data = data?.version === 1 ? data : {
      version: 1,
      weekday: new Array(SLOTS).fill(0),
      weekend: new Array(SLOTS).fill(0),
      weekdayCount: new Array(SLOTS).fill(0),
      weekendCount: new Array(SLOTS).fill(0),
    };
  }

  /** Adds one load sample. Samples are averaged per quarter hour before updating the profile. */
  addSample(time: Date, loadKw: number): void {
    if (!Number.isFinite(loadKw) || loadKw < 0) return;
    const key = new Date(Math.floor(time.getTime() / 900_000) * 900_000).toISOString();
    if (this.pending && this.pending.key !== key) this.flush();
    if (!this.pending) this.pending = { key, sum: 0, n: 0, date: new Date(key) };
    this.pending.sum += loadKw;
    this.pending.n++;
  }

  /** Commits the quarter currently being collected. */
  flush(): void {
    if (!this.pending || this.pending.n === 0) {
      this.pending = null;
      return;
    }
    const { slot, weekend } = this.slotOf(this.pending.date);
    const values = weekend ? this.data.weekend : this.data.weekday;
    const counts = weekend ? this.data.weekendCount : this.data.weekdayCount;
    const mean = this.pending.sum / this.pending.n;
    // Plain average until a few observations exist, then an exponential moving average.
    const weight = counts[slot] < 1 / this.alpha ? 1 / (counts[slot] + 1) : this.alpha;
    values[slot] = values[slot] + weight * (mean - values[slot]);
    counts[slot] = Math.min(counts[slot] + 1, 1000);
    this.pending = null;
  }

  /** Expected load in kW, or null when the slot has too few observations. */
  predict(time: Date): number | null {
    const { slot, weekend } = this.slotOf(time);
    const counts = weekend ? this.data.weekendCount : this.data.weekdayCount;
    if (counts[slot] >= this.minObservations) return (weekend ? this.data.weekend : this.data.weekday)[slot];
    // Fall back to the other day type if that has data.
    const other = weekend ? this.data.weekdayCount : this.data.weekendCount;
    if (other[slot] >= this.minObservations) return (weekend ? this.data.weekday : this.data.weekend)[slot];
    return null;
  }

  /** Quarters observed across all slots, for "is the profile trained" checks. */
  get observations(): number {
    return [...this.data.weekdayCount, ...this.data.weekendCount].reduce((a, b) => a + b, 0);
  }

  toJSON(): LoadProfileData {
    return this.data;
  }

  private slotOf(time: Date): { slot: number; weekend: boolean } {
    const { hour, minute, weekday } = localParts(time, this.timeZone);
    return { slot: hour * 4 + Math.floor(minute / 15), weekend: weekday === 0 || weekday === 6 };
  }
}
