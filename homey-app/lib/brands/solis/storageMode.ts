import type { WorkMode } from '../../inverter/types.js';

/** Storage mode bit field (SolisCloud CID 636 / Modbus register 43110). */
export const StorageBit = {
  selfUse: 0,
  timeOfUse: 1,
  offGrid: 2,
  backup: 4,
  gridCharge: 5,
  feedInPriority: 6,
  peakShaving: 11,
} as const;

export type StorageFlag = keyof typeof StorageBit;

export function hasFlag(raw: number, flag: StorageFlag): boolean {
  return (raw & (1 << StorageBit[flag])) !== 0;
}

export function withFlag(raw: number, flag: StorageFlag, on: boolean): number {
  const mask = 1 << StorageBit[flag];
  return on ? raw | mask : raw & ~mask;
}

/**
 * Storage mode used when this app controls the battery: self-use with time-of-use slots and
 * grid charging allowed, reserve (backup) on. Bits the app does not know about are kept.
 */
export function controlledStorageMode(raw: number, reserveEnabled: boolean): number {
  let mode = raw;
  mode = withFlag(mode, 'selfUse', true);
  mode = withFlag(mode, 'feedInPriority', false);
  mode = withFlag(mode, 'offGrid', false);
  mode = withFlag(mode, 'timeOfUse', true);
  mode = withFlag(mode, 'gridCharge', true);
  mode = withFlag(mode, 'backup', reserveEnabled);
  return mode;
}

export function describeStorageMode(raw: number): string {
  const flags = (Object.keys(StorageBit) as StorageFlag[]).filter((f) => hasFlag(raw, f));
  return `${raw} [${flags.join(', ') || 'none'}]`;
}

/** Solis storage mode as the controller sees it: time-of-use on while the app controls the battery. */
export const solisWorkMode: WorkMode = {
  controlled: controlledStorageMode,
  released: (raw) => withFlag(raw, 'timeOfUse', false),
  describe: describeStorageMode,
};
