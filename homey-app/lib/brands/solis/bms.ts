import type { BmsData } from '../../inverter/types.js';

/**
 * The battery's own fault words (Modbus 33145-33146, SolisCloud batteryFailureInformation01/02):
 * protection bits the BMS sets, all 0 in normal operation (160 SolisCloud snapshots, 23-26 Sep 2026,
 * Qapasity Arctic 21.68). The bits are shown as they are: their meaning differs between batteries.
 */
export function bmsFaultText(bms: BmsData | null | undefined): string | null {
  if (!bms || bms.faults.every((f) => !f)) return null;
  return `Battery (BMS) fault ${bms.faults.map((f) => `0x${f.toString(16).toUpperCase().padStart(4, '0')}`).join(' ')}`;
}
