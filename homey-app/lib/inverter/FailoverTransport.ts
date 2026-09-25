import type { HistorySample, InverterInfo, InverterSettings, InverterTransport, LiveData, TouSlot } from './types.js';

/**
 * Talks to the inverter through one connection at a time: the primary, or the fallback after the
 * primary failed several times in a row. SolisCloud commands and local Modbus both go through the
 * same data logger and disturb each other, so they are never used side by side. The primary is
 * tried again after a while.
 *
 * Live data and commands (reading and writing settings) are counted apart: SolisCloud can keep
 * delivering live data while its commands to the logger fail ("datalogger offline"). A failed
 * command is then tried once more through the fallback right away.
 *
 * History comes from the cloud's database whenever cloud credentials exist: that does not go
 * through the logger, so it is safe while Modbus is active.
 */
export class FailoverTransport implements InverterTransport {
  private usingFallback = false;
  private liveFailures = 0;
  private commandFailures = 0;
  private fallbackSince = 0;

  constructor(
    readonly primary: InverterTransport,
    readonly fallback: InverterTransport | null,
    private readonly history: InverterTransport | null,
    private readonly onSwitch: (active: InverterTransport, reason: string) => void = () => undefined,
    private readonly failuresBeforeSwitch = 3,
    private readonly retryPrimaryAfterMs = 30 * 60_000,
    private readonly now: () => number = Date.now,
    private readonly commandFailuresBeforeSwitch = 2,
  ) {
    if (history?.getHistory) this.getHistory = (date, tz) => history.getHistory!(date, tz);
  }

  get kind(): InverterTransport['kind'] {
    return this.active.kind;
  }

  get active(): InverterTransport {
    return this.usingFallback && this.fallback ? this.fallback : this.primary;
  }

  get onFallback(): boolean {
    return this.usingFallback;
  }

  getHistory?: (date: string, timeZone: string) => Promise<HistorySample[]>;

  getInfo(): Promise<InverterInfo> {
    return this.call('live', (t) => t.getInfo());
  }

  getLiveData(): Promise<LiveData> {
    return this.call('live', (t) => t.getLiveData());
  }

  readSettings(): Promise<InverterSettings> {
    return this.call('command', (t) => t.readSettings());
  }

  writeStorageMode(raw: number, previous?: number): Promise<void> {
    return this.call('command', (t) => t.writeStorageMode(raw, previous));
  }

  writeReserveSoc(pct: number, previous?: number): Promise<void> {
    return this.call('command', (t) => t.writeReserveSoc(pct, previous));
  }

  writeChargeSlot(index: number, slot: TouSlot, previous?: TouSlot): Promise<void> {
    return this.call('command', (t) => t.writeChargeSlot(index, slot, previous));
  }

  writeDischargeSlot(index: number, slot: TouSlot, previous?: TouSlot): Promise<void> {
    return this.call('command', (t) => t.writeDischargeSlot(index, slot, previous));
  }

  writeExportAllowed(allowed: boolean, previous: boolean): Promise<void> {
    return this.call('command', (t) => {
      if (!t.writeExportAllowed) throw new Error('This connection cannot switch export');
      return t.writeExportAllowed(allowed, previous);
    });
  }

  private async call<T>(kind: 'live' | 'command', fn: (t: InverterTransport) => Promise<T>): Promise<T> {
    this.maybeReturnToPrimary();
    const transport = this.active;
    try {
      const result = await fn(transport);
      if (kind === 'live') this.liveFailures = 0;
      else this.commandFailures = 0;
      return result;
    } catch (err) {
      if (this.usingFallback || !this.fallback) throw err;
      const failures = kind === 'live' ? ++this.liveFailures : ++this.commandFailures;
      const limit = kind === 'live' ? this.failuresBeforeSwitch : this.commandFailuresBeforeSwitch;
      if (failures < limit) throw err;
      this.usingFallback = true;
      this.fallbackSince = this.now();
      this.liveFailures = 0;
      this.commandFailures = 0;
      const what = kind === 'live' ? 'live data' : 'commands';
      this.onSwitch(this.fallback, `${this.primary.kind} ${what} failed ${failures} times: ${(err as Error).message}`);
      // The command did not get through: send it the other way now rather than at the next plan.
      if (kind === 'command') return fn(this.fallback);
      throw err;
    }
  }

  private maybeReturnToPrimary(): void {
    if (this.usingFallback && this.now() - this.fallbackSince >= this.retryPrimaryAfterMs) {
      this.usingFallback = false;
      this.liveFailures = 0;
      this.commandFailures = 0;
      this.onSwitch(this.primary, `trying ${this.primary.kind} again`);
    }
  }
}
