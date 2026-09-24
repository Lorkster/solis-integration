# Local Modbus through the S2-WL-ST logger

The app talks to the inverter through SolisCloud today: values every 5 minutes, settings written
through the cloud. Reading the inverter locally over Modbus TCP would give values every few seconds
and keep the app working when SolisCloud or the internet is down. This page is the plan for doing
that with the Wi-Fi logger that is already fitted, instead of the Waveshare RS485 adapter.

## What is known

- The S2-WL-ST logger has a Modbus TCP server on **port 502**, unit id 1. Solis's own guide
  ([S2-WL-ST Modbus TCP](https://solis-service.solisinverters.com/en/support/solutions/articles/44002530087-solis-s2-wl-st-modbus-tcp-communication))
  says it disconnects the logger from SolisCloud. That applied to older firmware.
- From logger firmware **100121cf** onwards, users report Modbus TCP and SolisCloud working at the
  same time, over Wi-Fi as well as LAN, including writes to control registers
  ([solis_modbus discussion](https://github.com/Pho3niX90/solis_modbus/discussions/154),
  [solax-modbus discussion](https://github.com/wills106/homeassistant-solax-modbus/discussions/1427)).
  Some also raised *Max. Number of Connections* for the logger in SolisCloud from 1 to 2.
- This logger reports firmware **100141e1** (read from SolisCloud on 24 Sep 2026), newer than the
  versions reported to work. No firmware update should be needed.
- Its Wi-Fi signal is **weak: −79 dBm** (SolisCloud's lowest level). Local polling would add traffic
  over that link; better coverage near the inverter (an access point or mesh node, or a cable to the
  logger's LAN port) would help both Modbus and SolisCloud.
- Reported problems: occasional logger resets, and the logger needs to reach its cloud server to
  stay connected.

## Steps

1. **Find the logger's address** in the router's list of connected devices. It usually shows up as
   an unnamed device or with a name starting with the logger's serial number.
2. **Give it a fixed address** in the router (DHCP reservation), so the app can find it.
3. **Switch Modbus TCP on.** Open `http://<logger address>` in a browser (user `admin`; you choose the
   password at the first login), then **Advanced → LAN settings / Modbus TCP**: enable it on port 502.
   The menu names differ between firmware versions. Afterwards `python tools/modbus_probe.py --find`
   confirms it: it lists the addresses on the network that answer on port 502.
4. **Test read-only:** `python tools/modbus_probe.py <address> --watch 30 --compare` reads SOC,
   solar, battery, grid, load and grid voltage every 30 seconds next to SolisCloud's values. It only
   reads; nothing is written. Leave it running for an hour and check that SolisCloud keeps updating.
5. **Build a local transport in the app** (`lib/inverter/types.ts` already separates the connection):
   live values over Modbus every 10–30 seconds, with SolisCloud as the fallback and for history.
   Writing the schedule over Modbus comes last, after reads have run stable for a week.

## What it would change in the app

| | SolisCloud (today) | Local Modbus |
|---|---|---|
| Live values | every 5 minutes, ~5 minutes old | every 10–30 seconds |
| Power-cut alarm | within 5–10 minutes | within a minute |
| Power-fee warning | once per 5 minutes | reacts during the hour |
| Works without internet | no | yes (reading; plan needs prices) |
| Setup | API key | fixed IP, Modbus switched on in the logger |
