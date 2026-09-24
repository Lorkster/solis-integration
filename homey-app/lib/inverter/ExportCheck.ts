import type { InverterSettings } from './types.js';

/**
 * Finds solar being thrown away: export switched off or capped in the inverter (a leftover from
 * SolisCloud's energy management, for example), or production held down to the house load while
 * the forecast says the panels could give much more.
 */
export type ExportIssue = 'export_blocked' | 'export_limited' | 'solar_throttled';

/** Export limits below this are treated as a cap rather than a grid-company limit (W). */
const LOW_LIMIT_W = 1000;

/** Issue visible in the inverter settings, ignoring a block the app set itself. */
export function exportSettingIssue(settings: InverterSettings | null, blockedByApp: boolean): ExportIssue | null {
  if (!settings) return null;
  if (settings.exportAllowed === false && !blockedByApp) return 'export_blocked';
  if (settings.exportAllowed !== false && settings.exportLimitW !== null && settings.exportLimitW !== undefined
    && settings.exportLimitW < LOW_LIMIT_W) return 'export_limited';
  return null;
}

/**
 * Production that follows the house load (no export, battery not charging) while the calibrated
 * forecast expects clearly more, for at least `minMinutes`.
 */
export class ThrottleDetector {
  private since: number | null = null;
  private lastEvidence = 0;
  throttled = false;

  /** Clears after `clearMinutes` without evidence, so passing clouds do not switch it on and off. */
  constructor(private readonly minMinutes = 30, private readonly clearMinutes = 60) {}

  update(time: Date, curtailedLooking: boolean, expectedPvKw: number | null, actualPvKw: number): boolean {
    const t = time.getTime();
    const shortfall = expectedPvKw !== null && expectedPvKw - actualPvKw > Math.max(1, 0.3 * expectedPvKw);
    const previous = this.throttled;
    if (curtailedLooking && shortfall) {
      this.since ??= t;
      this.lastEvidence = t;
      if (t - this.since >= this.minMinutes * 60_000) this.throttled = true;
    } else {
      this.since = null;
      if (this.throttled && t - this.lastEvidence >= this.clearMinutes * 60_000) this.throttled = false;
    }
    return this.throttled !== previous;
  }
}
