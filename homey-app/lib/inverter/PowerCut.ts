/**
 * Power cuts, as seen by the inverter: the grid side has no voltage (or the inverter reports that
 * the grid is missing) while the inverter itself is still online and reporting.
 */

/** Below this the grid is considered absent (normal is ~230 V). */
const MIN_GRID_VOLTAGE = 50;
/** Solis status texts that mean the grid is missing, e.g. "NO-Grid", "Grid Lost", "Off-grid". */
const NO_GRID_TEXT = /no[\s_-]*grid|grid[\s_-]*(lost|loss|off|down)|off[\s_-]*grid/i;

/** True when the detail shows no grid, false when the grid is present, null when it cannot tell. */
export function gridLost(detail: Record<string, unknown>): boolean | null {
  if (NO_GRID_TEXT.test(String(detail.faultCodeDesc ?? ''))) return true;
  const volts = ['uAc1', 'uAc2', 'uAc3'].map((k) => Number(detail[k])).filter(Number.isFinite);
  const hz = Number(detail.fac);
  if (volts.length === 0 && !Number.isFinite(hz)) return null;
  // Grid voltage is the reliable signal; off grid, the frequency may be the inverter's own 50 Hz.
  if (volts.length > 0) return volts.every((v) => v < MIN_GRID_VOLTAGE);
  return hz < 1;
}

export type PowerCutEvent = 'started' | 'ended' | 'backup_low';

export interface PowerCutState {
  since: string | null;
  lowNotified: boolean;
}

/** Keeps track of an ongoing power cut and reports when it starts, ends and when backup runs low. */
export class PowerCutTracker {
  since: Date | null;
  private lowNotified: boolean;

  constructor(state?: PowerCutState, private readonly lowBackupHours = 2) {
    this.since = state?.since ? new Date(state.since) : null;
    this.lowNotified = state?.lowNotified ?? false;
  }

  get active(): boolean {
    return this.since !== null;
  }

  /** Feeds one fresh live sample. Returns the events it caused, in order. */
  update(time: Date, lost: boolean | null, backupHours: number): PowerCutEvent[] {
    if (lost === null) return [];
    const events: PowerCutEvent[] = [];
    if (lost && !this.since) {
      this.since = time;
      this.lowNotified = false;
      events.push('started');
    } else if (!lost && this.since) {
      this.since = null;
      events.push('ended');
    }
    if (this.since && !this.lowNotified && Number.isFinite(backupHours) && backupHours < this.lowBackupHours) {
      this.lowNotified = true;
      events.push('backup_low');
    }
    return events;
  }

  toJSON(): PowerCutState {
    return { since: this.since?.toISOString() ?? null, lowNotified: this.lowNotified };
  }
}
