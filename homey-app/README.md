# Solis Smart Battery (Homey Pro app)

Plans battery charging for a Solis hybrid inverter from Nord Pool prices and writes the plan into the
inverter's own time-of-use slots, while keeping a backup reserve for power outages.

## How it works

1. **Prices** – 15-minute SE1–SE4 spot prices from elprisetjustnu.se, converted to real import/export
   prices (supplier fees, energy tax, grid fee incl. winter high-load time, VAT).
2. **Planner** (`lib/planner/planner.ts`) – dynamic programming over battery energy × 15-minute intervals.
   Each interval gets one action:
   - `self_use` – the inverter's normal mode: battery covers the house down to the reserve
   - `charge` – charge from the grid
   - `hold` – keep the stored energy for a later, more expensive period
   Battery wear, round-trip losses, a minimum gain and a switch penalty (to avoid fragmented plans) are included.
   House load per quarter hour comes from a **learned load profile** (`lib/forecast/LoadProfile.ts`):
   weekdays and weekends separately, bootstrapped from 14 days of SolisCloud 5-minute history at
   start-up and updated continuously from live data (exponential moving average, adapts within ~a week).
3. **Schedule** (`lib/planner/schedule.ts`) – the next 24 hours become up to 6 charge slots
   (`hold` = charge slot with 0 A). Slots are stored in the inverter and repeat daily, so the inverter
   keeps working if Homey, the internet or SolisCloud is down.
4. **Controller** (`lib/controller/BatteryController.ts`) – reads the inverter settings, writes only what
   differs (slots first, storage mode last), sets the backup reserve.

5. **Solar forecast** (`lib/forecast/SolarForecast.ts`) – 15-minute irradiance from Open-Meteo for each
   panel array, a physical PV model, and an hourly correction learned from measured production
   (shading, orientation), bootstrapped from 14 days of history.
6. **SMHI warnings** (`lib/warnings/SmhiWarnings.ts`) – impact-based warnings whose area contains
   Homey's location raise the reserve to the outage level until the warning ends.

The inverter connection is behind `InverterTransport` (`lib/inverter/types.ts`). `SolisCloudTransport`
is the only implementation today; a local Modbus TCP transport can be added without touching the rest.

## User interface

- **Device**: battery level and power (Homey Energy home battery), solar, house and grid power,
  current price, solar forecast today, backup reserve, backup time at current load, SMHI warning alarm,
  plan summary and control mode. All `measure_*` values can be pinned as tile indicators.
- **Widget "Battery plan"**: status in words, three stacked charts on one time axis (price with
  charge/save periods, solar and load forecast, battery level with reserve), touch/keyboard
  crosshair, and the schedule as a list.
- **Widget "Battery status"**: animated power flow between solar, grid, house and battery (honours
  reduced motion), backup time, reserve and current price.
- Colours validated for colour-vision deficiencies in light and dark mode; every state also has an
  icon and a label.

Widget previews are rendered from the real widget HTML with `tools/widget-preview/` (see the scripts).

## Control modes

- **Monitor only** (default after pairing) – plans and shows, never writes to the inverter.
- **Automatic** – writes the schedule. Switch the SolisCloud EMS off first, or the two will fight.

## Flow cards

Triggers: plan updated, planned action changed.
Conditions: planned action is …, price is among the N cheapest hours today.
Actions: set control mode, charge from grid for N minutes, save battery charge for N minutes,
prepare for a power outage (raise reserve to the configured level for N hours), cancel overrides,
update plan now, hand control back to the inverter.
SMHI: a warning was issued / ended, a warning is active.

## Development

```bash
npm install
npm test                 # unit tests (planner, schedule, SolisCloud client, controller)
npm run typecheck
npx homey app validate --level publish
npx homey app run        # run on your Homey (needs `npx homey login`)
npx homey app install    # install permanently
```

## Open items before switching to Automatic

- [ ] Verify on the inverter that a 0 A charge slot blocks discharge (hold) on TOU v2 firmware
- [ ] Verify the battery discharges to the house outside charge slots with time-of-use enabled
- [x] Read the off-grid over-discharge SOC (CID 469, 30 % on this inverter) for backup time and reserve warning
- [ ] Identify the SolisCloud field that shows the house running on the backup output
- [x] Learned load profile from observed consumption
- [x] Solar forecast with learned calibration
- [x] SMHI weather warnings → automatic outage preparation
- [x] Warn when a leftover SolisCloud remote command locks the battery at 0 A (`lib/inverter/LockDetector.ts`)
- [ ] Enter the real panel orientation (the calibration suggests east-facing or afternoon shade)
- [ ] Local Modbus TCP transport
