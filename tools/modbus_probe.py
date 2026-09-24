"""Read-only Modbus TCP probe for a Solis hybrid inverter behind an S2-WL-ST data logger.

Only reads input registers (function 04). Nothing is ever written.

  python tools/modbus_probe.py --find                 # look for loggers with port 502 open on this PC's /24 network
  python tools/modbus_probe.py 192.168.1.50           # read the key values once
  python tools/modbus_probe.py 192.168.1.50 --watch 30 --compare   # every 30 s, next to SolisCloud's values

Register map: Solis hybrid input registers as used by github.com/Pho3niX90/solis_modbus.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import socket
import struct
import sys
import time
from pathlib import Path

PORT = 502


class ModbusError(Exception):
    pass


class ModbusTcp:
    """Minimal Modbus TCP client: function 04 (read input registers) only."""

    def __init__(self, host: str, unit: int = 1, timeout: float = 5.0) -> None:
        self.host, self.unit, self.timeout = host, unit, timeout
        self.sock: socket.socket | None = None
        self.tid = 0

    def __enter__(self) -> "ModbusTcp":
        self.sock = socket.create_connection((self.host, PORT), timeout=self.timeout)
        return self

    def __exit__(self, *exc) -> None:
        if self.sock:
            self.sock.close()

    def _recv(self, n: int) -> bytes:
        data = b""
        while len(data) < n:
            chunk = self.sock.recv(n - len(data))
            if not chunk:
                raise ModbusError("connection closed by the logger")
            data += chunk
        return data

    def read_input(self, start: int, count: int) -> list[int]:
        self.tid = (self.tid + 1) & 0xFFFF
        pdu = struct.pack(">BHH", 4, start, count)
        self.sock.sendall(struct.pack(">HHHB", self.tid, 0, len(pdu) + 1, self.unit) + pdu)
        _tid, _proto, length, _unit = struct.unpack(">HHHB", self._recv(7))
        body = self._recv(length - 1)
        if body[0] & 0x80:
            raise ModbusError(f"exception code {body[1]} reading {start}+{count}")
        return list(struct.unpack(f">{body[1] // 2}H", body[2:2 + body[1]]))


def s16(v: int) -> int:
    return v - 0x10000 if v & 0x8000 else v


def u32(hi: int, lo: int) -> int:
    return (hi << 16) | lo


def s32(hi: int, lo: int) -> int:
    v = u32(hi, lo)
    return v - 0x100000000 if v & 0x80000000 else v


def read_values(client: ModbusTcp) -> dict[str, object]:
    """Reads the registers the app would need, in a few blocks."""
    r: dict[int, int] = {}
    for start, count in [(33000, 3), (33022, 6), (33049, 10), (33073, 3), (33094, 1),
                         (33133, 7), (33147, 6), (33263, 2)]:
        for i, v in enumerate(client.read_input(start, count)):
            r[start + i] = v
    battery_w = u32(r[33149], r[33150])
    return {
        "model code": f"{r[33000]:04X}",
        "firmware": f"DSP {r[33001]:04X} · HMI {r[33002]:04X}",
        "inverter clock": f"20{r[33022]:02d}-{r[33023]:02d}-{r[33024]:02d} {r[33025]:02d}:{r[33026]:02d}:{r[33027]:02d}",
        "PV power (W)": u32(r[33057], r[33058]),
        "PV1..4 (V×A)": [round(r[33049 + 2 * i] * 0.1 * r[33050 + 2 * i] * 0.1) for i in range(4)],
        "grid voltage (V)": [round(r[33073 + i] * 0.1, 1) for i in range(3)],
        "grid frequency (Hz)": round(r[33094] * 0.01, 2),
        "battery voltage (V)": round(r[33133] * 0.1, 1),
        "battery current (A)": round(r[33134] * 0.1, 1),
        "battery direction": {0: "charging", 1: "discharging"}.get(r[33135], r[33135]),
        "battery SOC (%)": r[33139],
        "battery power (W)": battery_w if r[33135] == 0 else -battery_w,
        "house load (W)": r[33147],
        "backup load (W)": r[33148],
        "AC grid port power (W)": s32(r[33151], r[33152]),
        "meter active power (W)": s32(r[33263], r[33264]),
    }


def cloud_values() -> dict[str, object]:
    """Same moment according to SolisCloud (read-only API), to check units and signs."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import solis_diag as sd  # noqa: PLC0415

    env = sd.load_env(Path(__file__).resolve().parents[1] / ".env")
    client = sd.SolisClient(env["KEY_ID"], env["KEY_SECRET"])
    d = client.inverter_detail(client.inverter_list()[0]["sn"])
    return {
        "SOC (%)": d.get("batteryCapacitySoc"),
        "PV (W)": round(sum(float(d.get(f"uPv{i}") or 0) * float(d.get(f"iPv{i}") or 0) for i in range(1, 5))),
        "battery (W, + charge)": float(d.get("batteryPowerZheng") or 0) or -float(d.get("batteryPowerFu") or 0),
        "grid psum (kW, − import)": d.get("psum"),
        "house load (kW)": d.get("familyLoadPower"),
        "sampled": time.strftime("%H:%M:%S", time.localtime(int(d.get("dataTimestamp", 0)) / 1000)),
    }


def find_loggers() -> list[str]:
    """Hosts on this PC's /24 network with the Modbus TCP port open."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    probe.connect(("8.8.8.8", 80))  # no packet is sent; picks the interface with the default route
    own = probe.getsockname()[0]
    probe.close()
    prefix = own.rsplit(".", 1)[0]

    def open_502(host: str) -> str | None:
        try:
            with socket.create_connection((host, PORT), timeout=0.6):
                return host
        except OSError:
            return None

    with concurrent.futures.ThreadPoolExecutor(64) as pool:
        found = [h for h in pool.map(open_502, [f"{prefix}.{i}" for i in range(1, 255)]) if h]
    print(f"Searched {prefix}.1–254 from {own}")
    return found


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("host", nargs="?")
    ap.add_argument("--unit", type=int, default=1, help="Modbus unit id (default 1)")
    ap.add_argument("--find", action="store_true", help="look for Modbus TCP port 502 on the local network")
    ap.add_argument("--watch", type=int, metavar="SECONDS", help="repeat every SECONDS")
    ap.add_argument("--compare", action="store_true", help="also show SolisCloud's values (needs .env)")
    args = ap.parse_args()

    if args.find:
        hosts = find_loggers()
        print("Port 502 open on:", ", ".join(hosts) if hosts else "none (Modbus TCP not enabled, or the logger is on another network)")
        return
    if not args.host:
        ap.error("give the logger's IP address, or use --find")

    while True:
        started = time.time()
        try:
            with ModbusTcp(args.host, args.unit) as client:
                values = read_values(client)
            print(time.strftime("%H:%M:%S"), f"Modbus ({(time.time() - started) * 1000:.0f} ms)")
            for k, v in values.items():
                print(f"  {k:24} {v}")
        except (OSError, ModbusError) as err:
            print(time.strftime("%H:%M:%S"), "Modbus failed:", err)
        if args.compare:
            try:
                print("  SolisCloud:", cloud_values())
            except Exception as err:  # noqa: BLE001
                print("  SolisCloud failed:", err)
        if not args.watch:
            break
        time.sleep(max(1, args.watch - (time.time() - started)))


if __name__ == "__main__":
    main()
