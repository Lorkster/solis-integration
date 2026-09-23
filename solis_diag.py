"""Read-only diagnostic for a Solis hybrid inverter via the SolisCloud API.

Dumps inverter details (firmware, live values) and every storage/schedule setting the
inverter currently holds, saves a timestamped JSON snapshot and shows what changed since
the previous snapshot. Never calls the control (write) endpoint.

Setup: copy .env.example to .env and fill in KEY_ID / KEY_SECRET (INVERTER_SN optional).

Usage:
    python solis_diag.py                  # one snapshot
    python solis_diag.py --watch 10       # snapshot every 10 minutes until Ctrl+C
    python solis_diag.py --cids 43,157    # additionally read arbitrary CIDs

CID map based on https://github.com/mkuthan/solis-cloud-control.
"""

import argparse
import base64
import hashlib
import hmac
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

BASE_URL = "https://www.soliscloud.com:13333"
HERE = Path(__file__).resolve().parent
SNAPSHOT_DIR = HERE / "snapshots"
REQUEST_DELAY_SECONDS = 0.6  # SolisCloud rate-limits aggressively

# Endpoints this script is allowed to call. /v2/api/control is deliberately absent.
READ_ONLY_ENDPOINTS = {
    "/v1/api/inverterList",
    "/v1/api/inverterDetail",
    "/v2/api/atRead",
    "/v2/api/atReadBatch",
}

TOU_V2_MARKER_CID = 6798
TOU_V2_MARKER_VALUE = "43605"  # 0xAA55 -> firmware uses the 6-slot schedule
TOU_V1_CID = 103

STORAGE_MODE_CID = 636
STORAGE_MODE_BITS = {
    0: "Self-Use",
    1: "Time of Use (TOU) switch",
    2: "Off-Grid",
    3: "Battery wake-up",
    4: "Backup / Reserve battery",
    5: "Allow grid charging",
    6: "Feed-in priority",
    7: "Battery OVC",
    8: "Force charge peak-shaving",
    9: "Battery current correction",
    10: "Battery healing",
    11: "Peak shaving",
}

SETTING_CIDS = {
    52: "Inverter ON register",
    54: "Inverter OFF register",
    56: "Inverter clock",
    636: "Storage mode (bit field)",
    157: "Backup/reserve SOC (%)",
    158: "Over-discharge SOC (%)",
    160: "Force-charge SOC (%)",
    7229: "Recovery SOC (%)",
    7963: "Max charge SOC (%)",
    7224: "Max charge current (A)",
    7226: "Max discharge current (A)",
    376: "Max output power (%)",
    499: "Max export power",
    15: "Power limit (%)",
    6962: "Export switch (0 = export allowed per reference impl.)",
    6968: "Export calibration",
    4754: "MPPT scanning",
    4755: "MPPT scan interval (s)",
}

# (switch, time, current, soc) per slot, TOU v2 firmware
CHARGE_SLOTS = [
    (5916, 5946, 5948, 5928),
    (5917, 5949, 5951, 5929),
    (5918, 5952, 5954, 5930),
    (5919, 5955, 5957, 5931),
    (5920, 5958, 5960, 5932),
    (5921, 5961, 5963, 5933),
]
DISCHARGE_SLOTS = [
    (5922, 5964, 5967, 5965),
    (5923, 5968, 5971, 5969),
    (5924, 5972, 5975, 5973),
    (5925, 5976, 5979, 5977),
    (5926, 5980, 5983, 5981),
    (5927, 5987, 5986, 5984),
]
SLOT_CIDS = [cid for slot in CHARGE_SLOTS + DISCHARGE_SLOTS for cid in slot]

INTERESTING_DETAIL_KEYS = [
    "model", "machine", "version", "collectorModel", "stateExceptionFlag", "state",
    "dataTimestamp", "timeZone", "energyStorageControl", "smartSupport",
    "parallelNumber", "parallelBattery",
    "pac", "pacStr", "eToday", "eTodayStr",
    "batteryCapacitySoc", "batteryHealthSoc", "batteryPower", "batteryPowerStr",
    "batteryVoltage", "storageBatteryCurrent", "batteryType", "batteryModel",
    "batteryChargingCurrent", "batteryDischargeLimiting",
    "batteryTodayChargeEnergy", "batteryTodayDischargeEnergy",
    "gridPurchasedTodayEnergy", "gridSellTodayEnergy",
    "homeLoadTodayEnergy", "familyLoadPower", "psum", "psumStr",
]


class SolisError(Exception):
    pass


def load_env(path: Path) -> dict[str, str]:
    if not path.exists():
        sys.exit(f"Missing {path.name}. Copy .env.example to .env and fill in your API key.")
    env = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


class SolisClient:
    def __init__(self, key_id: str, key_secret: str) -> None:
        self._key_id = key_id
        self._key_secret = key_secret.encode("utf-8")

    def post(self, endpoint: str, payload: dict):
        if endpoint not in READ_ONLY_ENDPOINTS:
            raise SolisError(f"Refusing to call non-read-only endpoint {endpoint}")

        body = json.dumps(payload)
        content_md5 = base64.b64encode(hashlib.md5(body.encode("utf-8")).digest()).decode()
        content_type = "application/json"
        date = datetime.now(UTC).strftime("%a, %d %b %Y %H:%M:%S GMT")
        to_sign = "\n".join(["POST", content_md5, content_type, date, endpoint])
        signature = base64.b64encode(
            hmac.new(self._key_secret, to_sign.encode("utf-8"), hashlib.sha1).digest()
        ).decode()

        request = urllib.request.Request(
            BASE_URL + endpoint,
            data=body.encode("utf-8"),
            method="POST",
            headers={
                "Content-MD5": content_md5,
                "Content-Type": content_type,
                "Date": date,
                "Authorization": f"API {self._key_id}:{signature}",
            },
        )
        time.sleep(REQUEST_DELAY_SECONDS)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                result = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            raise SolisError(f"HTTP {err.code}: {err.read().decode('utf-8', 'replace')[:300]}") from err
        except urllib.error.URLError as err:
            raise SolisError(f"Network error: {err.reason}") from err

        if str(result.get("code")) != "0":
            raise SolisError(f"API code {result.get('code')}: {result.get('msg')}")
        return result.get("data")

    def inverter_list(self) -> list[dict]:
        return self.post("/v1/api/inverterList", {"pageSize": "100"})["page"]["records"]

    def inverter_detail(self, sn: str) -> dict:
        return self.post("/v1/api/inverterDetail", {"sn": sn})

    def read(self, sn: str, cid: int) -> str:
        return self.post("/v2/api/atRead", {"inverterSn": sn, "cid": cid})["msg"]

    def read_batch(self, sn: str, cids: list[int]) -> dict[int, str]:
        data = self.post("/v2/api/atReadBatch", {"inverterSn": sn, "cids": ",".join(map(str, cids))})
        return {int(item["cid"]): item["msg"] for group in data for item in group}


def read_cids(client: SolisClient, sn: str, cids: list[int], errors: dict) -> dict[int, str]:
    """Batch read in chunks, falling back to single reads if a batch fails."""
    values: dict[int, str] = {}
    for i in range(0, len(cids), 20):
        chunk = cids[i : i + 20]
        try:
            values.update(client.read_batch(sn, chunk))
        except SolisError as err:
            errors[f"atReadBatch {chunk}"] = str(err)
            for cid in chunk:
                try:
                    values[cid] = client.read(sn, cid)
                except SolisError as single_err:
                    errors[f"cid {cid}"] = str(single_err)
    return values


def take_snapshot(client: SolisClient, sn: str | None, extra_cids: list[int]) -> dict:
    errors: dict[str, str] = {}

    if not sn:
        inverters = client.inverter_list()
        if not inverters:
            raise SolisError("No inverters found for this API key")
        for inv in inverters:
            print(f"  found inverter sn={inv.get('sn')} model={inv.get('model')} station={inv.get('stationName')}")
        sn = inverters[0]["sn"]

    detail = client.inverter_detail(sn)

    try:
        tou_marker = client.read(sn, TOU_V2_MARKER_CID)
    except SolisError as err:
        tou_marker = None
        errors[f"cid {TOU_V2_MARKER_CID}"] = str(err)

    cids = list(SETTING_CIDS) + SLOT_CIDS + [TOU_V1_CID] + extra_cids
    values = read_cids(client, sn, list(dict.fromkeys(cids)), errors)

    return {
        "taken_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "inverter_sn": sn,
        "tou_v2_marker": tou_marker,
        "cids": {str(k): v for k, v in sorted(values.items())},
        "errors": errors,
        "detail": detail,
    }


def decode_storage_mode(raw: str | None) -> list[str]:
    try:
        mode = int(raw)
    except (TypeError, ValueError):
        return [f"unreadable ({raw!r})"]
    lines = [f"raw={mode}  binary={mode:016b}"]
    for bit, name in STORAGE_MODE_BITS.items():
        lines.append(f"  [{'X' if mode & (1 << bit) else ' '}] bit {bit:2d}  {name}")
    unknown = mode & ~sum(1 << b for b in STORAGE_MODE_BITS)
    if unknown:
        lines.append(f"  unknown bits set: {unknown:016b}")
    return lines


def print_report(snap: dict, extra_cids: list[int]) -> None:
    cids = snap["cids"]
    detail = snap["detail"] or {}

    def val(cid: int) -> str:
        return cids.get(str(cid), "-")

    print(f"\n=== Solis diagnostic {snap['taken_at']}  inverter {snap['inverter_sn']} ===")

    print("\n-- Inverter details --")
    for key in INTERESTING_DETAIL_KEYS:
        if key in detail and detail[key] not in (None, ""):
            print(f"  {key:30s} {detail[key]}")
    for key, value in sorted(detail.items()):
        if "version" in key.lower() and key not in INTERESTING_DETAIL_KEYS and value not in (None, ""):
            print(f"  {key:30s} {value}")

    print("\n-- Storage mode (CID 636) --")
    for line in decode_storage_mode(cids.get(str(STORAGE_MODE_CID))):
        print("  " + line)

    print("\n-- Other settings --")
    for cid, name in SETTING_CIDS.items():
        if cid != STORAGE_MODE_CID:
            print(f"  {cid:5d}  {name:55s} {val(cid)}")

    v2 = snap["tou_v2_marker"] == TOU_V2_MARKER_VALUE
    print(f"\n-- Time-of-use schedule (firmware schedule: {'v2, 6 slots' if v2 else 'v1, 3 slots'};"
          f" CID {TOU_V2_MARKER_CID}={snap['tou_v2_marker']}) --")
    print(f"  {'slot':12s} {'enabled':8s} {'time':14s} {'current A':10s} {'SOC %':6s}")
    for label, slots in (("charge", CHARGE_SLOTS), ("discharge", DISCHARGE_SLOTS)):
        for i, (sw, tm, cur, soc) in enumerate(slots, 1):
            enabled = {"1": "yes", "0": "no"}.get(val(sw), val(sw))
            print(f"  {label + ' ' + str(i):12s} {enabled:8s} {val(tm):14s} {val(cur):10s} {val(soc):6s}")
    print(f"  v1 schedule string (CID {TOU_V1_CID}): {val(TOU_V1_CID)}")

    if extra_cids:
        print("\n-- Extra CIDs --")
        for cid in extra_cids:
            print(f"  {cid:5d}  {val(cid)}")

    if snap["errors"]:
        print("\n-- Errors --")
        for what, err in snap["errors"].items():
            print(f"  {what}: {err}")
        if all("cid" in k or "atRead" in k for k in snap["errors"]) and not cids:
            print("  -> Settings could not be read at all. The key probably lacks control-API access;")
            print("     request it from Solis support (ticket) for this inverter.")


def print_diff(previous: dict, current: dict) -> None:
    before, after = previous["cids"], current["cids"]
    changed = [(k, before.get(k), after.get(k)) for k in sorted(set(before) | set(after), key=int)
               if before.get(k) != after.get(k) and k != "56"]  # 56 is the clock, always changes
    print(f"\n-- Changes since {previous['taken_at']} --")
    if not changed:
        print("  none")
    for cid, old, new in changed:
        name = SETTING_CIDS.get(int(cid), "")
        print(f"  CID {cid:5s} {name:40s} {old!r} -> {new!r}")
        if cid == str(STORAGE_MODE_CID):
            for line in decode_storage_mode(new)[1:]:
                print("      " + line)


def latest_snapshot() -> dict | None:
    files = sorted(SNAPSHOT_DIR.glob("snapshot-*.json"))
    return json.loads(files[-1].read_text(encoding="utf-8")) if files else None


def save_snapshot(snap: dict) -> Path:
    SNAPSHOT_DIR.mkdir(exist_ok=True)
    path = SNAPSHOT_DIR / f"snapshot-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    path.write_text(json.dumps(snap, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def run_once(client: SolisClient, sn: str | None, extra_cids: list[int]) -> None:
    previous = latest_snapshot()
    snap = take_snapshot(client, sn, extra_cids)
    print_report(snap, extra_cids)
    if previous:
        print_diff(previous, snap)
    print(f"\nSaved {save_snapshot(snap).relative_to(HERE)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Read-only SolisCloud inverter diagnostic")
    parser.add_argument("--watch", type=float, metavar="MINUTES", help="repeat every N minutes")
    parser.add_argument("--cids", default="", help="comma-separated extra CIDs to read")
    args = parser.parse_args()

    env = load_env(HERE / ".env")
    if not env.get("KEY_ID") or not env.get("KEY_SECRET"):
        sys.exit("KEY_ID and KEY_SECRET must be set in .env")
    client = SolisClient(env["KEY_ID"], env["KEY_SECRET"])
    extra_cids = [int(c) for c in args.cids.split(",") if c.strip()]

    while True:
        try:
            run_once(client, env.get("INVERTER_SN") or None, extra_cids)
        except SolisError as err:
            print(f"\nERROR: {err}")
            if not args.watch:
                sys.exit(1)
        if not args.watch:
            break
        print(f"\nNext snapshot in {args.watch:g} min (Ctrl+C to stop)")
        try:
            time.sleep(args.watch * 60)
        except KeyboardInterrupt:
            break


if __name__ == "__main__":
    main()
