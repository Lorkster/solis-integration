# Installing Solis Smart Battery on Homey Pro

The app is not in the Homey App Store. It is installed from your computer with Homey's official
command-line tool (the Homey CLI). This takes about 10 minutes the first time. Afterwards the app runs
on the Homey by itself; the computer is only needed again to install updates.

**Requirements**

- Homey Pro (Early 2023) or newer. Homey Cloud cannot run custom apps.
- A Windows, Mac or Linux computer on the same network as the Homey.
- [Node.js](https://nodejs.org) 18 or newer, and [Git](https://git-scm.com).
  Check in a terminal with `node --version` and `git --version`.
- Your Homey account (the same login as in the Homey mobile app).
- A SolisCloud API key (see [step 5](#5-add-the-inverter-in-homey)).

---

## Install

### 1. Download the app

Open a terminal (on Windows: PowerShell or Windows Terminal) in the folder where you want the code:

```bash
git clone https://github.com/Lorkster/solis-integration.git
```

```bash
cd solis-integration/homey-app
```

### 2. Install the tools the app needs

```bash
npm ci
```

This downloads the Homey CLI and the build tools into the project folder. Nothing is installed system-wide.

### 3. Log in to Homey

```bash
npx homey login
```

A browser window opens. Log in with your Homey account and allow access. Back in the terminal it says
you are logged in.

If you have more than one Homey, choose which one to use:

```bash
npx homey select
```

### 4. Install the app on the Homey

```bash
npx homey app install
```

The first time, the CLI asks **Choose an active Homey**: pick yours with the arrow keys and press Enter.
The CLI then builds the app and uploads it to your Homey. When it reports that the app is installed, you can
close the terminal. The app now appears in the Homey app under **More → Apps → Solis Smart Battery**.

> Use `npx homey app install`, not `npx homey app run`. `run` is for development: the app stops as soon
> as you close the terminal.

### 5. Add the inverter in Homey

1. In the Homey app, go to **Devices → + (add) → Solis Smart Battery → Solis hybrid inverter**.
2. The first screen explains where to find the API key:
   **soliscloud.com → Account → Basic Settings → API Management**. Copy the **Key ID** and **Key Secret**.
3. Enter them, pick your inverter from the list and finish. It is added as **Home battery**;
   rename it as you like. If the list is empty, the account has no Solis hybrid inverter the app can
   use (see [Supported inverters](docs/USER-GUIDE.md#supported-inverters)).

The first minute after adding it, the app reads 14 days of history from SolisCloud to learn your
consumption pattern and how your solar panels actually perform.

### 6. Check the settings

Open the device and tap the gear icon (settings). The most important groups:

| Group | What to check |
|---|---|
| **Backup reserve** | How much the battery always keeps for power outages (25 % April–October, 30 % November–March by default). During an outage the battery can be used from whatever level it has down to the inverter's power-outage limit (Off-Grid Overdischarge SOC in SolisCloud; Solis ships 30 %, 15 % is a good choice for LFP batteries). The device warns if the reserve is not above that limit. |
| **Solar forecast** | Size (kWp), tilt and direction of your panels. With two directions (e.g. east and west roofs), fill in both arrays. The forecast comes from Open-Meteo by default; Forecast.Solar and Solcast can be chosen instead. |
| **Weather warnings** | On by default: the battery is charged to the outage level when a warning covers your location. Choose SMHI (Sweden) or MET Norway (Norway). |
| **Battery** | Capacity and charge power. The defaults match a 21.68 kWh Qapasity Arctic. |
| **Electricity price** | Price source, price area and the fees from your electricity and grid invoices. elprisetjustnu.se covers Sweden; Nord Pool covers the Nordics, the Baltics and much of Western Europe. |
| **Power fee** | Only if your grid company charges per kW of your peaks (effektavgift): switch it on and copy the terms from its price list. |
| **Notifications** | Timeline notifications for power cuts and for an inverter that stops following the plan are on; a daily savings summary can be switched on. |
| **Inverter** | Read only: model, rated power, firmware and whether the app can control this inverter. |

The app uses the location set in Homey (**More → Settings → Location**) for the solar forecast and
weather warnings.

### 7. Add the dashboard widgets

In the Homey app, open a dashboard (or create one), tap the **pencil** to edit it, then
**+ Add Widget → Apps → Solis Smart Battery** and choose (step-by-step instructions with pictures:
[user guide](docs/USER-GUIDE.md#adding-the-widgets-to-a-dashboard)):

- **Battery plan**: prices, planned charging and saving, solar and load forecast, battery level.
  Touch and drag across the chart to see the details for any quarter-hour.
- **Battery status**: live power flow between solar, grid, house and battery, with backup time.

### 8. Let it take control

The app starts in **Monitor only**: it plans and shows, but never changes the inverter. Keep it like that
for a day or two and check that the plan makes sense. Then:

1. **Switch off the SolisCloud EMS**: in SolisCloud, open the energy management strategy and tap the
   check mark on the active strategy so none is selected. Otherwise SolisCloud and the app will
   overwrite each other.
2. In Homey, set the device's **Control mode** to **Automatic**.

From then on the app writes the charging schedule into the inverter every half hour when it changes.

---

## Update

When a new version is available on GitHub:

```bash
cd solis-integration
```

```bash
git pull
```

```bash
cd homey-app
```

```bash
npm ci
```

```bash
npx homey app install
```

The device, its settings, your flows and everything the app has learned are kept.

---

## Uninstall

The app writes a charging schedule into the inverter, and **the inverter keeps repeating it every day
after the app is gone**. So hand control back first:

1. **Hand control back to the inverter.** Either:
   - delete the device (**device → settings → Remove device**) while the control mode is
     **Automatic**: the app then clears its schedule automatically, or
   - run a flow with the action **"Hand control back to the inverter"**, then delete the device.
2. **Uninstall the app**: Homey app → **More → Apps → Solis Smart Battery → Uninstall**.
3. **Check the inverter** in SolisCloud (**Inverter Control**): time-of-use should be off and the
   charge slots empty. Set it up the way you want, or switch the SolisCloud EMS back on.

Nothing needs to be removed from the computer, but you can delete the `solis-integration` folder.

---

## Troubleshooting

| Problem | What to do |
|---|---|
| `npx homey app install` cannot find the Homey | Make sure the computer and the Homey are on the same network, run `npx homey select`, and try again. |
| Pairing says the key is invalid | Check the Key ID and Key Secret in SolisCloud API Management; copy them again without spaces. |
| The device shows **"Planning failed: … Access denied"** | The API key can read but not control the inverter. Ask Solis support to enable control access for the API. |
| Warnings like **"datalogger offline"** | The WiFi logger lost its connection briefly. The app retries by itself; the inverter keeps running its schedule meanwhile. |
| **"Battery locked by SolisCloud"** | A SolisCloud EMS strategy or Quick Control command has left the battery at 0 A, so it neither charges nor discharges and no inverter setting overrides it. Make sure no EMS strategy is selected, then in SolisCloud run **Quick Control → Discharge** with about 2 kW, target SOC above your reserve and a duration of 1 hour. When it ends, the limit returns to normal. |
| The plan looks wrong | Check the settings (battery capacity, price fees, solar panels). The plan improves as the app learns during the first days. |
