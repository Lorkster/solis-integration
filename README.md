# solis-integration

Price-driven battery control for a Solis hybrid inverter (S6-EH3P, TOU v2 firmware) via the SolisCloud API.

Background: the SolisCloud "Self-use" EMS strategy only plans from the moment it is saved until midnight
the same day and never generates plans for the following days. This project replaces it with a scheduler
that writes charge slots directly to the inverter based on Nord Pool day-ahead prices, while keeping a
battery reserve for power outages.

**To install the Homey app, see [INSTALL.md](INSTALL.md).**

## Status

- [x] `solis_diag.py` – read-only diagnostic: firmware, live values, storage mode bits, all TOU slots,
      snapshots with change detection (`--watch`)
- [x] Homey Pro 2023 app in [`homey-app/`](homey-app/): price planner, learned load profile, solar
      forecast, SMHI warnings, TOU slot writing, backup reserve, flows, two dashboard widgets
      (see its README for open items)
- [ ] Verify inverter behaviour with TOU enabled (discharges to house outside charge slots? 0 A slot = hold?)

## Diagnostic usage

```bash
cp .env.example .env   # fill in KEY_ID / KEY_SECRET from SolisCloud API management
python solis_diag.py              # one snapshot
python solis_diag.py --watch 10   # every 10 minutes, prints changes
```

Requires Python 3.11+, standard library only. Snapshots are written to `snapshots/` (git-ignored, they
contain the inverter serial number).

## References

- CID map and API signing: [mkuthan/solis-cloud-control](https://github.com/mkuthan/solis-cloud-control)
