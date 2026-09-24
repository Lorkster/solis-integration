/**
 * Detects a battery frozen by a leftover SolisCloud remote-control command.
 *
 * SolisCloud's EMS and Quick Control steer the battery through a remote current limit
 * (batteryCDEnableSet / batteryCDISet in the inverter data). When a command is left behind at 0 A,
 * the battery neither charges nor discharges, and no inverter setting overrides it. It is released
 * by running a Quick Control command with a duration in SolisCloud; when that ends the limit returns
 * to its default.
 *
 * To avoid false alarms, the lock is only reported when it persists and actually costs something:
 * the house imports from the grid while the battery is above its reserve. An active 0 A time-of-use
 * slot (the app's own "save") shows the same 0 A limit, so it is never counted as a lock.
 */
export interface LockSample {
  time: Date;
  remoteEnabled: boolean | null;
  remoteCurrentA: number | null;
  socPct: number;
  gridW: number; // positive = import
  batteryW: number;
}

export class LockDetector {
  private since: Date | null = null;
  private evidence = false;
  locked = false;

  constructor(private readonly minMinutes = 30, private readonly importThresholdW = 300) {}

  /**
   * Feeds one live sample. `plannedSave` is true while the app's own schedule has a 0 A slot active.
   * Returns true when the locked state changed.
   */
  update(sample: LockSample, reserveSoc: number, plannedSave = false): boolean {
    const zeroLimit = sample.remoteEnabled === true && sample.remoteCurrentA === 0;
    if (!zeroLimit || plannedSave) {
      this.since = null;
      this.evidence = false;
      return this.set(false);
    }
    this.since ??= sample.time;
    const idle = Math.abs(sample.batteryW) < 50;
    if (idle && sample.gridW > this.importThresholdW && sample.socPct > reserveSoc + 2) this.evidence = true;
    const persisted = sample.time.getTime() - this.since.getTime() >= this.minMinutes * 60_000;
    return this.set(persisted && this.evidence);
  }

  private set(value: boolean): boolean {
    const changed = value !== this.locked;
    this.locked = value;
    return changed;
  }
}
