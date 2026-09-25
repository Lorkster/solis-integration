/**
 * SolisCloud control IDs (CIDs) for hybrid inverters.
 * Sources: https://github.com/mkuthan/solis-cloud-control and Solis' official command list
 * (https://oss.soliscloud.com/doc/SolisCloud_control_api_command_list.xlsx), verified against an S6-EH3P20K-H.
 */
export const Cid = {
  storageMode: 636,
  reserveSoc: 157,
  overDischargeSoc: 158,
  offGridOverDischargeSoc: 469,
  forceChargeSoc: 160,
  maxChargeSoc: 7963,
  maxChargeCurrent: 7224,
  maxDischargeCurrent: 7226,
  clock: 56,
  touV2Marker: 6798,
  /** The older 3-slot schedule as one text (firmware without the 6+6 slots). */
  touV1: 103,
  /** Export to the grid: "0" = allowed, "1" = blocked (a bit of a shared register). */
  exportBlocked: 6962,
  /** Export power limit in units of 100 W. */
  exportLimit: 499,
} as const;

/** "Old value" SolisCloud needs when switching export: the register as it is now. */
export const EXPORT_REGISTER = { allowed: '80', blocked: '88' } as const;

/** Value of CID 6798 when the firmware uses the 6+6 slot schedule (0xAA55). */
export const TOU_V2_MARKER = '43605';

export interface SlotCids {
  switch: number;
  time: number;
  current: number;
  soc: number;
}

export const CHARGE_SLOT_CIDS: SlotCids[] = [
  { switch: 5916, time: 5946, current: 5948, soc: 5928 },
  { switch: 5917, time: 5949, current: 5951, soc: 5929 },
  { switch: 5918, time: 5952, current: 5954, soc: 5930 },
  { switch: 5919, time: 5955, current: 5957, soc: 5931 },
  { switch: 5920, time: 5958, current: 5960, soc: 5932 },
  { switch: 5921, time: 5961, current: 5963, soc: 5933 },
];

export const DISCHARGE_SLOT_CIDS: SlotCids[] = [
  { switch: 5922, time: 5964, current: 5967, soc: 5965 },
  { switch: 5923, time: 5968, current: 5971, soc: 5969 },
  { switch: 5924, time: 5972, current: 5975, soc: 5973 },
  { switch: 5925, time: 5976, current: 5979, soc: 5977 },
  { switch: 5926, time: 5980, current: 5983, soc: 5981 },
  { switch: 5927, time: 5987, current: 5986, soc: 5984 },
];

export const SETTINGS_CIDS: number[] = [
  Cid.storageMode,
  Cid.reserveSoc,
  Cid.overDischargeSoc,
  Cid.offGridOverDischargeSoc,
  Cid.forceChargeSoc,
  Cid.maxChargeSoc,
  Cid.maxChargeCurrent,
  Cid.maxDischargeCurrent,
  ...[...CHARGE_SLOT_CIDS, ...DISCHARGE_SLOT_CIDS].flatMap((s) => [s.switch, s.time, s.current, s.soc]),
];
