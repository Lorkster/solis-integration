# Home Battery Planner (Homey Pro app)

> **Using the app?** See the [user guide](../docs/USER-GUIDE.md) and [INSTALL.md](../INSTALL.md).
> This file is for development.

Plans home battery charging from day-ahead prices and writes the plan into the inverter's own
time-of-use slots, while keeping a backup reserve for power outages. Brand-neutral: the planner,
learning, widgets and flows are shared, and each inverter brand plugs in behind one interface.
Solis is the first brand; see [docs/ADDING-A-BRAND.md](../docs/ADDING-A-BRAND.md) for adding another.

## Code layout

| Where | What | Brand-specific? |
|---|---|---|
| `lib/planner/`, `lib/controller/` | Planner, schedule builder, controller that writes only what changed | No |
| `lib/forecast/`, `lib/energy/`, `lib/prices/`, `lib/warnings/`, `lib/tariff.ts` | Solar and load forecasts, savings, power fee, prices, weather warnings | No |
| `lib/inverter/` | The inverter model (`types.ts`: `InverterTransport`, `WorkMode`), failover, power-cut and plan checks | No |
| `lib/homey/BatteryPlannerDevice.ts` | The home battery device: everything the app does with Homey | No |
| `lib/homey/flowCards.ts`, `.homeycompose/flow/` | App-wide flow cards; the device argument lists each brand's driver | No |
| `lib/homey/EnergyChildDevice.ts`, `drivers/solis-solar`, `drivers/solis-grid` | Solar panels and Grid meter for Homey Energy, fed by any brand's inverter device (the driver ids are historical) | No |
| `lib/brands/solis/` | SolisCloud API, Solis Modbus registers, storage mode bits, 3-slot schedule | Yes |
| `drivers/solis-inverter/` | Solis pairing and the Solis device (connections, texts) | Yes |
| `lib/modbus/ModbusTcpClient.ts` | Plain Modbus TCP client, usable by any brand | No |

Ids of capabilities, settings and flow cards contain `solis` from before the app was brand-neutral.
They are internal (users never see them) and are kept so existing devices, insights and flows keep
working.

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

The inverter connection is behind `InverterTransport` (`lib/inverter/types.ts`). Solis has two:
`SolisCloudTransport` and `SolisModbusTransport` (`lib/brands/solis/`), used one at a time through
`FailoverTransport`.

## Documentation

`docs/USER-GUIDE.md` is partly generated: the device values, settings and flow cards come from the
manifest files, and the widget pictures are rendered from the widget code. After changing any of
those, run `node tools/gen-docs.mjs` (CI fails if the generated parts are out of date).
User-facing descriptions of device values live in `tools/gen-docs.mjs` (`MEANING`).

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

App-wide, one file per card in `.homeycompose/flow/` (the number keeps their order in the Flow
editor); handlers in `lib/homey/flowCards.ts`. The full list with explanations is generated into
the user guide ("All flow cards").

## Before the first App Store publish

- [ ] Change the app id to `com.lorkster.batteryplanner` (`.homeycompose/app.json`, `package.json`,
      `APP_ID` in `tools/dashboard/host.html`). An id can never change after publishing. Homey treats
      the new id as a new app: remove the old app first (two apps must never control the inverter),
      then pair again and re-enter the settings.

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

- [x] Verify on the inverter that a 0 A charge slot blocks discharge (hold) on TOU v2 firmware (24 Sep 2026)
- [x] Verify the battery discharges to the house outside charge slots with time-of-use enabled (24 Sep 2026)
- [x] Read the off-grid over-discharge SOC (CID 469, now 15 % on this inverter) for backup time and reserve warning
- [ ] Confirm power-cut detection (grid voltage uAc1–3, `lib/inverter/PowerCut.ts`) during a real cut
- [x] Learned load profile from observed consumption
- [x] Solar forecast with learned calibration
- [x] SMHI weather warnings → automatic outage preparation
- [x] Warn when a leftover SolisCloud remote command locks the battery at 0 A (`lib/inverter/LockDetector.ts`)
- [ ] Enter the real panel orientation (the calibration suggests east-facing or afternoon shade)
- [x] Local Modbus TCP transport
