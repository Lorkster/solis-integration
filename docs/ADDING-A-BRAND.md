# Adding an inverter brand

Home Battery Planner is brand-neutral. Everything the user sees and everything that decides what the
battery does is shared: the planner, the forecasts, the savings and power fee, the widgets, the
dashboard page, the flow cards and the Homey Energy devices. A brand only teaches the app how to
**talk to its inverter**. Solis is the first brand and the example to copy.

## What a brand provides

| Part | Solis example | Size |
|---|---|---|
| One or more **connections** implementing `InverterTransport` | `lib/brands/solis/SolisCloudTransport.ts`, `SolisModbusTransport.ts` | the real work |
| A **work mode** (`WorkMode`), or `NO_WORK_MODE` | `solisWorkMode` in `lib/brands/solis/storageMode.ts` | a few lines |
| A **device** class extending `BatteryPlannerDevice` | `drivers/solis-inverter/device.ts` | ~70 lines |
| A **driver**: pairing, and a manifest that reuses the shared template | `drivers/solis-inverter/` | pairing screens + ~40 lines of JSON |

Put brand code in `lib/brands/<brand>/` and the driver in `drivers/<brand>-inverter/`. Keep notes
on what you verified on the real inverter, like [Solis notes](SOLIS-NOTES.md): settings that
silently block the schedule are the hardest part.

## 1. The connection: `InverterTransport`

Defined in `homey-app/lib/inverter/types.ts`. Signs and units are fixed, whatever the inverter reports:

- `getLiveData()` returns `LiveData`: battery power **positive while charging**, grid power
  **positive while importing**, W and kWh, and `timestamp` = when the inverter sampled the values
  (not when they were fetched). Unknown lifetime totals are `NaN`, unknown `gridLost` is `null`.
- `getInfo()` returns `InverterInfo`. Set `hybrid: false` for inverters without a battery (they are
  not offered when pairing) and `touV2: true` when every schedule slot has its own target level.
- `readSettings()` returns the schedule as **charge slots** (`TouSlot`: daily start and end time,
  current in A, target SOC), and as many discharge slots. The app keeps discharge slots switched
  off, so a brand without them returns disabled ones and never gets a discharge-slot write.
- `writeChargeSlot()`, `writeReserveSoc()`, `writeStorageMode()` change one thing each. Read the value
  back where the protocol allows it and throw when it did not stick. The controller only writes what
  differs from what it read, and passes the previous value for protocols that need it.
- `writeExportAllowed()` is optional (export control at negative prices).
- `getHistory()` is optional: past days in 5-minute samples. With it, the app learns the house's
  consumption and the panels' behaviour from day one instead of after a few days.
- `kind` is `'cloud'` or `'local'` (local connections are read more often); `name` is shown to the user.

How the plan maps onto slots (`lib/planner/schedule.ts`):

- **Charge from the grid**: a slot with a current above 0 A and the target SOC.
- **Save the battery** (hold): a slot with **0 A**. On Solis, an active charge slot stops discharging,
  so the house runs on the grid and the battery keeps its energy. If your brand holds the battery
  differently, translate a 0 A slot into that in the transport.
- **Self-use**: no slot. The inverter's normal mode covers the house from the battery.

Slots repeat daily, so the inverter keeps following the last schedule if Homey or the internet is
down. Brands that take power in W instead of A convert with the battery voltage (`LiveData.batteryVoltageV`).

If the brand has a cloud and a local connection that go through the same logger, return both from
`connections()`: `FailoverTransport` uses one at a time and switches after repeated failures.

## 2. The work mode: `WorkMode`

Many inverters need a mode switched on before they follow a schedule (Solis: the time-of-use bit in
the storage mode). `controlled()` returns the mode while the app controls the battery, `released()`
the mode after **Hand control back to the inverter**. Keep bits you do not know about. Without such a
setting, use `NO_WORK_MODE`.

## 3. The device

```ts
export default class AcmeInverterDevice extends BatteryPlannerDevice {
  protected readonly workMode = acmeWorkMode;

  protected connections(settings: Settings, id: string): Connections {
    const cloud = new AcmeCloudTransport(String(settings.acme_token), id);
    return { primary: cloud, fallback: null, history: cloud };
  }
}
```

Optional overrides, all with sensible defaults: `connectionName()`, `localLiveIntervalMs()`,
`mergeInfo()`, `scheduleSlots()` (default 6), `canControl()`, `cannotControlText()` and `lockWarning()`.

## 4. The driver

`drivers/<brand>-inverter/driver.compose.json` extends the shared template, which brings the device
class (`battery`), all capabilities and the Homey Energy settings. The settings groups are shared too; only the
connection group is the brand's own:

```json
{
  "$extends": ["battery-planner"],
  "name": { "en": "Acme hybrid inverter" },
  "connectivity": ["cloud"],
  "images": { "small": "{{driverAssetsPath}}/images/small.png", "large": "...", "xlarge": "..." },
  "pair": [ ... ],
  "settings": [
    { "type": "group", "label": { "en": "Connection" }, "children": [ ... ] },
    { "$extends": "planner-backup" },
    { "$extends": "planner-solar" },
    { "$extends": "planner-warnings" },
    { "$extends": "planner-battery" },
    { "$extends": "planner-price" },
    { "$extends": "planner-power-level" },
    { "$extends": "planner-power-fee" },
    { "$extends": "planner-planning" },
    { "$extends": "planner-notifications" },
    { "$extends": "planner-inverter" }
  ]
}
```

The templates live in `homey-app/.homeycompose/drivers/templates/` and `.../drivers/settings/`.

`driver.ts` only handles pairing. Give each device a stable `data.id` (e.g. the serial number) and
start from the price area where Homey is (`suggestPriceArea`), as the Solis driver does.

**Flow cards** are app-wide (`.homeycompose/flow/`). Add the new driver to every card's device
filter, e.g. `driver_id=solis-inverter|acme-inverter`:

```bash
sed -i 's/"driver_id=solis-inverter"/"driver_id=solis-inverter|acme-inverter"/' homey-app/.homeycompose/flow/*/*.json
```

The **widgets**, the **dashboard page** and the **Solar panels** and **Grid meter** devices find
every brand's inverter device on their own.

## 5. Before you open a pull request

- Unit tests for the transport: parse real responses (with serial numbers and keys removed) and
  check the signs. See `test/transport.test.ts` and `test/modbus.test.ts`.
- `npm test`, `npm run typecheck` and `npx homey app validate --level publish` pass.
- Run it in **Monitor only** for a day and compare the live values with the manufacturer's app.
- Then try **Automatic** and check that the inverter follows a charge slot and a 0 A hold. Write down
  what you tested in the pull request.
- Add the brand to **Supported inverters** in `docs/USER-GUIDE.md`, then run `node tools/gen-docs.mjs`.

Never commit API keys, serial numbers or anything that identifies a house.
