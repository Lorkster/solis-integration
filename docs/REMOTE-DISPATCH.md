# Design: grid charging and holds through Remote Dispatch

Status: **built in 0.3.0** (27 Sep 2026): device setting *Battery control → Remote Dispatch (Modbus)*.
The logic is in `lib/controller/direct.ts` (plan → command), `SolisModbusTransport.writeDirect`
(registers) and `BatteryPlannerDevice.runDirect` (when to write, failsafe, fallback).

## Why

Today the app carries out its plan by writing time-of-use slots (charge slots with a current,
holds as 0 A slots) through SolisCloud. Two problems:

1. **Slots stop charging from the grid.** On 26 and 27 Sep, slots that were switched on, with every
   documented condition met (storage mode 51, 43342 = 16 A, Remote Dispatch off), did not take power
   from the grid until SolisCloud's Quick Control had run. The app's Modbus pulse (1 kW, 45 s) did
   not clear it on 27 Sep. Quick Control always did, and while it runs it charges reliably.
   No register in 43000–43999 or 44000–44199 differs between blocked and working
   ([SOLIS-NOTES](SOLIS-NOTES.md)). See *What 27 Sep showed* at the end.
2. **Flash wear.** A Solis engineer warns that the time-charging settings are stored in flash
   (about 10,000 write cycles) and recommends the Remote Dispatch registers, which are in RAM, for
   active control ([solis-sensor #464](https://github.com/hultenvp/solis-sensor/issues/464)).
   The app rewrites slots whenever a replan moves a charge: four times between 11:07 and 12:20 on
   27 Sep, several registers each time.

Quick Control *is* Remote Dispatch (registers 44100–44199, Solis Modbus protocol Ver3.2 pp. 132–136).
Letting the app use it directly does what works, without the slots.

## What Remote Dispatch offers (official document, Ver3.2)

| Register | Meaning | Use here |
|---|---|---|
| 34502 | 0xAA55 = supported (this inverter: yes; function version 34503 = 3) | check once |
| 34504 | status: 0 off, 1 default, 2 real-time, 3 TOU control | read back after a write |
| 44100 | switch, 0 off / 1 on; **nothing is kept over a power cycle** | on while the app steers |
| 44101 | failsafe 1–1440 min: without a fresh write the inverter ends dispatch | see *Failsafe* |
| 44105 | 1 battery standby (no charge, no discharge), 2 charge/discharge, 3/4 grid-point control | 1 = hold, 2 = charge |
| 44106–07 | power, S32, 10 W, positive = charge | planned charge power |
| 44108 | function bits; 0x5555 = grid charging allowed, PV and off-grid standby not disabled | always 0x5555 |
| 44109–10 | SOC window, lower and upper | upper = the charge's target SOC |
| 44111–15 | reserved (Quick Control writes 44112 = 0; idle 10000) | see *Unknowns* |
| 44116–44199 | 6 dispatch TOU periods, 14 registers each, same fields plus start/end | not in phase 1 |

## Proposal

### Mapping the plan to dispatch commands

The plan already gives one action per quarter hour (`self_use`, `hold`, `charge` with a power and a
target). The app turns the *current* action into one command:

| Plan action | Command |
|---|---|
| charge | 44105 = 2, power = planned kW (at most the battery's limit), 44108 = 0x5555, 44109–10 = 0 – target SOC |
| hold (a save that keeps energy above the reserve) | 44105 = 1 (standby) |
| self-use | 44100 = 0 (dispatch off: the inverter runs its own self-use) |

It writes only when the command changes: at the start and end of each charge or hold, and when a
replan changes the current block's power or target. That is a few Modbus writes a day, all to RAM.
A timer set to the next planned change triggers the write, so nothing polls.

Each write is one session: the general block (44100–44104) and the real-time block (44105–44115),
as the document asks, then a read of 34504 and 44100 to confirm (status 2 while charging or holding).

### The time-of-use slots become a fixed fallback

With dispatch in use, the app switches all time-of-use slots off once and leaves them alone: the
inverter falls back to plain self-use whenever dispatch ends (failsafe, power cycle, app stopped).
The storage mode (51), the reserve and the export flag stay as today, written only when they change.

### Failsafe

The failsafe is a watchdog: dispatch ends when nothing is written for that many minutes. Set it to
the time until the next planned change plus 10 minutes (at most 1440). Then:

- the app writes nothing between changes;
- if the app or Homey stops, the inverter goes back to self-use at the latest 10 minutes after the
  block should have ended, and a charge also ends at its target SOC (44110);
- a replan that extends a block rewrites the failsafe.

### Connection

Remote Dispatch is only reachable over Modbus (SolisCloud rejects these as CIDs,
[solis-sensor #464](https://github.com/hultenvp/solis-sensor/issues/464)). So:

- control commands go over **Modbus**; SolisCloud stays the source of live data and history (free,
  no inverter traffic), and is no longer used for commands in this mode, so the two do not collide;
- if a Modbus write fails twice, the app falls back to today's method (slots through SolisCloud) for
  that block and reports it;
- a new device setting chooses the method: *Time slots* (today) or *Remote Dispatch (needs Modbus)*.
  Without a Modbus address only time slots are offered.

### Checks

- After each write: 44100 and 34504 read back as expected, or the write counts as failed.
- The plan check (`PlanMonitor`) stays: a charge that does not charge still raises *off plan*.
- A power cut: dispatch off (as `restoreInverter` does for slots), so nothing holds the battery back.
- The Remote Dispatch pulse and the hidden-block workaround are no longer needed in this mode.

## To verify on the inverter first (with the owner present)

1. **Charge**: 44105 = 2 at 6.5 kW, target 40 %: charges at about 6.5 kW from the grid (Quick Control
   at 5 kW gave 4.97 kW), stops at 40 %.
2. **Hold**: 44105 = 1 with the house on the grid: battery at 0 W, no discharge.
3. **Failsafe**: 44101 = 1, no further writes: dispatch ends after a minute, 34504 back to 0.
4. **Reserved 44112**: does a charge work without writing it (as the app's pulse did), or only with 0
   (as Quick Control writes)?
5. **Slots off, dispatch off**: plain self-use down to the reserve.
6. **SolisCloud next to it**: live data keeps arriving; no cloud commands are sent in this mode.
7. **Storage mode**: a dispatch charge with 43110 = 33 (time of use off) still charges.

Each is one short Modbus session with the probe tool; results go into SOLIS-NOTES.

### Results (27 Sep 2026, 12:44–12:56, app in Monitor mode, a 16 A slot charging underneath)

Written as the document asks: 44100–44104, then 44105–44112, each one FC16 write.

| Test | Result |
|---|---|
| 1 Charge | **Pass.** 3 kW → 3.03 kW (7.1 A) within 20 s, overriding the slot's 16 A; 6 kW → 5.96 kW. Stopped at the upper SOC (35 %): 0 W from then on. At the limit, surplus solar was **exported**, not stored. |
| 2 Hold | **Pass.** 44105 = 1: 0 W for the whole minute (34504 = 0x0102). Surplus solar exported here too. |
| 3 Failsafe | **Pass.** 1 min: dispatch ended by itself about a minute after the write; the inverter reset 44100–44112 to their idle values (failsafe 5, mode 1, flags 0) and the slot charged at 16 A again within 30 s. |
| 4 Reserved 44112 | **Not needed.** All charges above left it at 10000. |
| 5 Self-use | Not repeated (verified 24 Sep: slots off, time of use on → self-use down to the reserve). |
| 6 SolisCloud | Live data kept coming, but the 12:49 and 12:54 uploads arrived late (the app saw 12:44 until about 12:57). Short Modbus sessions a few times a day should not matter; polling during a test does. |
| 7 Storage mode 33 | **Pass.** A 3 kW dispatch charge worked with 43110 = 33 (time of use off). 43110 was written back to 51 afterwards. Side note: the slot kept charging for the 35 s between writing 33 and starting dispatch, so the time-of-use bit may take effect with a delay. |

Consequences for the design:

- A charge must hand back to self-use as soon as it reaches its target (or the plan's end): a
  dispatch charge that sits at its upper SOC blocks solar charging.
- A hold through dispatch standby also blocks solar charging. The plan's holds happen when the
  battery should keep its energy, usually at night; in daylight the plan should prefer self-use.
- The inverter resets the dispatch registers itself when dispatch ends, so the app always writes
  the whole general and real-time blocks.

## Unknowns and risks

- **Undocumented fields.** Quick Control sets reserved 44112 (and the same field in dispatch periods
  4–6) from 10000 to 0. Unknown meaning; test 4 decides whether the app writes it.
- **Firmware function version 3** is newer than the V01 the document describes; modes 5/6 exist in
  later versions. Test 1–3 confirm the behaviour on this firmware.
- **Weak Wi-Fi to the logger** (−79 dBm). A few writes a day are fine, but a failed write must fall
  back cleanly (above).
- **Brands.** This is Solis-specific. It fits behind the transport as an optional `directControl`,
  so other brands keep the slot method.

## As built (0.3.0)

- **Commands** as proposed. The charge power is the block's lowest planned power; the target is its
  final level. A charge that has reached its target (live SOC) behaves like a hold.
- **Daytime holds**: a hold in a quarter where the plan expects surplus solar is carried out as
  self-use (dispatch off), so the surplus charges the battery instead of being exported; self-use
  does not discharge while solar covers the house. With direct control the planner models a hold
  that way (`holdStoresSurplus`). The same applies to a finished charge.
- **When it writes**: after each plan update, at the plan's next change (a timer), and on live data
  (a reached target). Only when the command changes, or when the failsafe would end before the block
  does (renewed at most about once a day for long blocks). Right after a start it waits for the
  first plan, so a running command survives a restart.
- **Taking over again**: if live data contradicts the command three minutes after it was written
  (not charging, or a hold that moves more than 500 W), the command is written again, at most every
  15 minutes. This covers a Quick Control from the SolisCloud app, which replaces the app's dispatch.
- **Fallback**: two unconfirmed writes in a row → time slots until the settings change or the app
  restarts. Switching the setting back to time slots, Monitor mode, a power cut or deleting the
  device switch dispatch off.
- **Slots**: switched off by the next plan update in this mode (through SolisCloud), then left alone.
  The storage mode, reserve and export flag are handled as before. The grid-charging pulse is off.

## Grid import limit (0.3.4)

With the device setting *Max grid import* (e.g. 15 kW for a 25 A fuse), every charge or hold command
also sets the inverter's system import limit: 44102 = 1 (bit 0), 44103 = the limit in 100 W steps.
Solis' document says the inverter then keeps the grid import at or below it. The planner also plans
charges within the limit, using the forecast house load. *To verify on the inverter: during a charge,
a limit just below the current import must lower the charge power, while the house keeps its power.*

## Phase 2 (later, optional)

Remote Dispatch also has six TOU periods in RAM (44116–44199). The app could load the whole day's
plan there, so the inverter follows it even while the app is down, with the failsafe renewed at each
replan. Only worth it once phase 1 works; it is untested whether these periods share the slots' block.

## What 27 Sep showed

- **11:07–12:14: blocked.** Slots written at 11:07 (11:00–13:45) and 11:51 (11:45–17:15), 16 A,
  storage mode 51, 43342 = 16 A, Remote Dispatch off: the battery took only surplus solar. The app's
  pulse at 11:59 (1 kW, 45 s) did not help.
- **12:14–12:16: Quick Control → Charge** (5 kW, 0x5555, SOC window 0–40 %, failsafe 59 min):
  4.97 kW while it ran; afterwards the slot charged at its own 16 A. All scanned registers were
  back to their blocked-state values.
- **Between 12:17 and 12:37 the storage mode went from 51 to 33** (time of use and backup off; the
  mode from before the app), with no write by the app: something on the SolisCloud side, probably
  the end of Quick Control. The app's live-data check caught it (12:37, "storage mode 33 ≠ 49"),
  read the settings once and wrote 51 back at 12:38.
- **12:38: a slot written 8 minutes after its start (12:30–17:15) charged at 16 A at once.** So a
  late write is not what blocks the slots; once cleared, the block stays away through a mode change
  and slot rewrites. What sets it again (overnight on 26 Sep, some time before 11:00 on 27 Sep) is
  unknown.

For this design that means: Remote Dispatch sidesteps the block, probably also the storage mode
(to verify: test 7), and a Quick Control started from the SolisCloud app will
overwrite the app's dispatch, so the app must read 34504/44100 back and take over again when it ends.
