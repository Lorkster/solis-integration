# Solis hybrid inverters: what we have verified

Hard-won facts about Solis hybrids (tested on an **S6-EH3P20K-H**, HMI 1262 / DSP 0945, S2-WL-ST
logger), for anyone using or extending the app. Each item says how it was confirmed. The user-facing
version of the fixes is in the [user guide](USER-GUIDE.md#troubleshooting).

## Time-of-use schedule (TOU v2, 6 + 6 slots)

| Behaviour | Verified |
|---|---|
| Outside the charge slots, with time-of-use on, the battery powers the house down to the reserve (self-use). | 24 Sep 2026 |
| A charge slot with **0 A** holds the battery: it neither charges nor discharges, the house runs on the grid. | 24 Sep 2026, again every night since |
| A charge slot with a current above 0 A charges from the grid at that current up to the slot's SOC, then stops at the slot's end time. | 26 Sep 2026, 16 A = 6.7 kW, stopped exactly at 03:00 |
| Slots repeat every day and carry no date. | by design; the app clips slots so tomorrow's never start today |

### Grid charging needs three settings

A charge slot only takes power from the grid when **all** of these hold:

1. **Storage mode** (CID 636 / register 43110): bit 1 *time of use* and bit 5 *allow grid to charge
   the battery* are on. The app sets both (value 51 with backup on).
2. **Max grid charging current** (register **43342**, 0.1 A) is above 0. Factory default 80 A.
   **SolisCloud cannot read or write it on hybrids**; CID 538 with that name is for Solis' off-grid
   models only. The app reads it over Modbus when a logger address is set up and warns *Grid charging
   is blocked in the inverter* at 0 A.
3. **Remote Dispatch** (register 44100) is off. While SolisCloud's Quick Control or energy
   management is running, it steers the battery directly and the slots wait.

### The 26 Sep 2026 incident

Every planned grid charge had silently done nothing. The diagnosis, step by step:

1. The slot was in the inverter and switched on (checked over Modbus, register 43707), and the
   battery stayed at 0 W. There were no faults, and the battery management allowed 37.6 A of charging.
2. SolisCloud **Quick Control → Charge** (grid charging allowed) *did* charge at 5 kW, so the grid,
   battery and permissions were fine.
3. Solis' Modbus document showed that Quick Control runs through **Remote Dispatch** (44100–44199),
   which ignores register 43342, and that 43342 read **0 A**.
4. After writing 43342 = 16 A (the battery's max charge current), the app's slot charged at once.

We don't know who set 0 A: it may have been the installer, or SolisCloud's energy management, which
had controlled this inverter before. **If you have the same symptom** (Quick Control charges, slots
don't), run `python tools/modbus_probe.py <logger address> --grid-charge`.

## SolisCloud API quirks

- **Slot switches share one register.** CIDs 5916–5927 are bits of register 43707, and SolisCloud
  builds the new value from the "old value" sent with the command, so that must be the whole bit
  field.
- **The inverter refuses to switch on a slot that overlaps another active slot**, silently: the
  command is accepted and the switch stays off (26 Sep 2026: at 01:57 a charge slot overlapping the
  old hold, at 11:06 a charge identical to one already running in another slot). The app therefore
  keeps a planned slot where an identical one already runs, switches changed and old slots off
  first, and only then writes and switches on the new ones. It reads each switch back for up to 15
  seconds and resends it if needed. A slot that would overlap one that could not be switched off is
  not switched on, and the failure is reported; the next plan update retries within 30 minutes.
- SolisCloud accepts a control command before the logger delivers it, so a command can still be
  lost when the logger is busy; the read-back covers that too.
- **Export flag is inverted:** CID 6962 `0` = export allowed, `1` = blocked (register 43483 bit 3).
- **Leftover remote commands** from the energy management can freeze the battery at 0 A
  (`batteryCDISet` in the inverter detail). A Quick Control command *with a duration* resets it to
  normal when it ends. `batteryCDEnableSet = 1` with 50 A, or with the slot's current, is normal.
- Error **B0173** ("device has timed out") and **"Command send fail"** mean the logger did not
  deliver the command. Retry after a minute.

## Modbus next to SolisCloud

- The S2-WL-ST answers Modbus TCP on port 502 while it keeps uploading to SolisCloud.
- **Modbus traffic while a SolisCloud command is on its way makes the command fail.** Frequent
  polling breaks cloud control completely (25 Sep test), and even single reads can clash with a
  command in flight (26 Sep). So the app reads over Modbus only sparingly, between its own commands,
  while SolisCloud is the connection.
- Register reference: Solis' *RS485_MODBUS (ESINV-33000ID) Hybrid Inverter* document, attached to
  [Pho3niX90/solis_modbus#93](https://github.com/Pho3niX90/solis_modbus/issues/93):
  43110 bits (appendix 6), 43342 (p. 86), 43707+ slots (p. 105), 44100+ Remote Dispatch (p. 132).

## Still unverified

- Power-cut detection from the grid voltage, during a real outage.
- Writing the schedule over Modbus on the real inverter: only read-back tests and one register write
  (43342) so far.
- The older 3-slot schedule (CID 103), on an inverter that has it.
