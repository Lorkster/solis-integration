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

## Status on this installation (24 Sep 2026)

The logger was found by its `D_<serial>` name and **already answered on port 502** – Modbus TCP was
on without any change. A read-only read of the key registers took under a second and matched
SolisCloud (SOC, battery, solar, house, grid, grid voltage). The meter power register (33263) is
negative while importing, like SolisCloud's `psum`. SolisCloud kept receiving its 5-minute
uploads afterwards; the longer daytime test below shows the limits. The logger's address is now reserved in the
router. Next: a longer read-only run (`--watch 30`) during a day, then the local transport.

## Daytime test (25 Sep 2026, 08:00–13:28, one read a minute)

- 328 reads, 1 failure. Normal reads took ~0.9 s, but every 5 minutes – while the logger uploads
  to SolisCloud – they took 3–5 s: both share the logger's single RS485 link to the inverter.
- The logger restarted once (09:30). It had also restarted the night before, without Modbus.
- From 13:26, **SolisCloud commands to the inverter timed out** (B0173) repeatedly, and one cloud
  upload came late. A minute after the Modbus reads stopped, commands worked again.
- Conclusion: on this logger and Wi-Fi, local reads and cloud commands **cannot run side by side**
  reliably. The app writes its schedule through cloud commands, so the test was stopped.

Options:
1. **All local**: read *and* write over Modbus, so no cloud commands go through the logger; keep
   SolisCloud only as a passive log. Removes the conflict, but writes must be built and tested with
   care (register map from solis_modbus).
2. **Light local reads**: poll far less often (every 5 minutes, away from the upload moment) –
   little gain over the cloud.
3. **Better link first**: the weak Wi-Fi (−80 dBm) may make the logger slower than it needs to be;
   a stronger signal or a cable to the logger's LAN port could reduce the contention. Re-test after.

## Grid charging and Remote Dispatch (26 Sep 2026)

Modbus found why the time slots never charged from the grid: register **43342** (max grid charging
current) was 0 A, which SolisCloud cannot see. Setting it to 16 A fixed it. It also showed that
SolisCloud's Quick Control runs through **Remote Dispatch** (44100). Single reads next to cloud
commands can still make a command fail. Details: [Solis notes](SOLIS-NOTES.md).
`python tools/modbus_probe.py <address> --grid-charge` shows all grid-charge settings.

## Steps

1. **Find the logger's address** in the router's list of connected devices. The S2-WL-ST names
   itself **`D_` followed by its serial number** (the logger serial in SolisCloud), and its web page
   is not always on port 80, so it is easy to miss. `python tools/modbus_probe.py --find` lists the
   addresses that answer on port 502.
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
