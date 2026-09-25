import type { TouSlot } from '../inverter/types.js';

/**
 * The older time-of-use schedule (firmware without the 6+6 slots): CID 103 holds all three slots
 * as one comma-separated text, in one of two layouts (as handled by
 * github.com/mkuthan/solis-cloud-control):
 *  - 18 fields, per slot: charge A, discharge A, charge start, charge end, discharge start, discharge end
 *  - 12 fields, per slot: charge A, discharge A, "charge start-end", "discharge start-end"
 * There is no target level and no switch per slot: a slot is off when its times are 00:00-00:00.
 */
export const TOU_V1_SLOTS = 3;
const OFF = '00:00';

export interface TouV1 {
  perSlot: 6 | 4;
  fields: string[];
}

export function parseTouV1(value: string | undefined | null): TouV1 | null {
  if (!value) return null;
  const fields = value.split(',').map((f) => f.trim());
  if (fields.length === 18) return { perSlot: 6, fields };
  if (fields.length === 12) return { perSlot: 4, fields };
  return null;
}

export function formatTouV1(t: TouV1): string {
  return t.fields.join(',');
}

function times(t: TouV1, index: number, kind: 'charge' | 'discharge'): [string, string] {
  const base = index * t.perSlot;
  if (t.perSlot === 6) {
    const at = base + (kind === 'charge' ? 2 : 4);
    return [t.fields[at] || OFF, t.fields[at + 1] || OFF];
  }
  const [start = OFF, end = OFF] = (t.fields[base + (kind === 'charge' ? 2 : 3)] || '').split('-');
  return [start, end];
}

/** The three charge and three discharge slots. `soc` is 100 (not part of this format). */
export function touV1Slots(t: TouV1): { charge: TouSlot[]; discharge: TouSlot[] } {
  const slot = (index: number, kind: 'charge' | 'discharge'): TouSlot => {
    const [start, end] = times(t, index, kind);
    const currentA = Number(t.fields[index * t.perSlot + (kind === 'charge' ? 0 : 1)]) || 0;
    return { enabled: start !== end, start, end, currentA, soc: 100 };
  };
  const range = [...Array(TOU_V1_SLOTS).keys()];
  return { charge: range.map((i) => slot(i, 'charge')), discharge: range.map((i) => slot(i, 'discharge')) };
}

/** Sets one slot; a disabled slot becomes 00:00-00:00 at 0 A. */
export function setTouV1Slot(t: TouV1, kind: 'charge' | 'discharge', index: number, slot: TouSlot): void {
  if (index < 0 || index >= TOU_V1_SLOTS) {
    if (slot.enabled) throw new Error(`The 3-slot schedule has no slot ${index + 1}`);
    return;
  }
  const base = index * t.perSlot;
  const [start, end] = slot.enabled ? [slot.start, slot.end] : [OFF, OFF];
  t.fields[base + (kind === 'charge' ? 0 : 1)] = String(slot.enabled ? Math.round(slot.currentA) : 0);
  if (t.perSlot === 6) {
    const at = base + (kind === 'charge' ? 2 : 4);
    t.fields[at] = start;
    t.fields[at + 1] = end;
  } else {
    t.fields[base + (kind === 'charge' ? 2 : 3)] = `${start}-${end}`;
  }
}
