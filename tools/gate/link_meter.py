#!/usr/bin/env python3
"""ThroughNet placement helper: live per-node CSI rate + TX-link RSSI.

Binds UDP 5005 (stop the sensing-server first). Prints one line per interval
with, for each RX node: frames/sec and median RSSI of the received beacon
frames (i8 at ADR-018 byte 16). Use while repositioning boards: aim for
>= 35 fps and RSSI >= -60 dBm per link.
"""
import socket, struct, sys, time, statistics as st

interval = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0
total = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", 5005))
s.settimeout(0.2)

end = time.time() + total
win = {}  # node -> list of rssi this interval
t0 = time.time()
while time.time() < end:
    try:
        data, _ = s.recvfrom(2048)
        if len(data) >= 20 and struct.unpack("<I", data[:4])[0] == 0xC5110001:
            node = data[4]
            rssi = int.from_bytes(data[16:17], "little", signed=True)
            win.setdefault(node, []).append(rssi)
    except socket.timeout:
        pass
    now = time.time()
    if now - t0 >= interval:
        parts = []
        for node in sorted(win):
            r = win[node]
            parts.append(f"node{node}: {len(r)/(now-t0):5.1f}fps rssi {st.median(r):6.1f}dBm")
        print(" | ".join(parts) if parts else "(no CSI frames — TX powered? channel?)", flush=True)
        win = {}
        t0 = now
