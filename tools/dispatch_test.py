"""Remote Dispatch test helper, used for the tests in docs/REMOTE-DISPATCH.md (27 Sep 2026). Writes only 44100-44112, as blocks (FC16), then reads back.

  python dispatch.py status
  python dispatch.py charge <watts> <soc_upper> <failsafe_min> [--reserved0] [--import <watts>]
  python dispatch.py standby <failsafe_min>
  python dispatch.py off
  python dispatch.py watch <seconds> <every>
"""
import struct
import sys
import time

sys.path.insert(0, r'C:\Users\magnu\Claude\Projects\solisintegration\tools')
from modbus_probe import ModbusTcp, read_values  # noqa: E402

HOST = '192.168.1.97'
IDLE_GENERAL = [0, 5, 0, 0xFFFF, 0xFFFF]              # 44100-44104
IDLE_REALTIME = [1, 0, 0, 0, 0, 100, 40, 10000]        # 44105-44112


def write_multiple(m: ModbusTcp, start: int, values: list[int]) -> None:
    pdu = struct.pack(f'>BHHB{len(values)}H', 16, start, len(values), 2 * len(values), *values)
    m._request(pdu)


def status(m: ModbusTcp) -> str:
    d = m.read_holding(44100, 13)
    st = m.read_input(34504, 1)[0]
    v = read_values(m)
    power = (d[6] << 16 | d[7])
    power = power - (1 << 32) if power >= 1 << 31 else power
    limit = f"import<={d[3] * 100} W " if d[2] & 1 else ''
    return (f"{v['inverter clock'][11:]} dispatch {d[0]} failsafe {d[1]} {limit}mode {d[5]} power {power * 10} W "
            f"flags 0x{d[8]:04X} soc {d[9]}-{d[10]} r2 {d[12]} | status {st & 0xff}/{st >> 8} | "
            f"battery {v['battery power (W)']} W {v['battery current (A)']} A SOC {v['battery SOC (%)']} | "
            f"PV {v['PV power (W)']} house {v['house load (W)']} meter {v['meter active power (W)']}")


def main() -> None:
    cmd = sys.argv[1]
    with ModbusTcp(HOST) as m:
        if cmd == 'charge':
            watts, soc_upper, failsafe = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
            p = (watts // 10) & 0xFFFFFFFF
            r2 = 0 if '--reserved0' in sys.argv else 10000
            limit = int(sys.argv[sys.argv.index('--import') + 1]) // 100 if '--import' in sys.argv else None
            write_multiple(m, 44100, [1, failsafe, 1 if limit else 0, limit or 0xFFFF, 0xFFFF])
            write_multiple(m, 44105, [2, p >> 16, p & 0xFFFF, 0x5555, 0, soc_upper, 40, r2])
        elif cmd == 'standby':
            failsafe = int(sys.argv[2])
            write_multiple(m, 44100, [1, failsafe, 0, 0xFFFF, 0xFFFF])
            write_multiple(m, 44105, [1, 0, 0, 0x5555, 0, 100, 40, 10000])
        elif cmd == 'off':
            write_multiple(m, 44100, IDLE_GENERAL)
            write_multiple(m, 44105, IDLE_REALTIME)
        if cmd != 'watch':
            time.sleep(1)
            print(status(m), flush=True)
    if cmd == 'watch':
        total, every = int(sys.argv[2]), int(sys.argv[3])
        end = time.time() + total
        while time.time() < end:
            with ModbusTcp(HOST) as m:
                print(status(m), flush=True)
            time.sleep(every)


if __name__ == '__main__':
    main()
