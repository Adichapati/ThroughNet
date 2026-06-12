#!/usr/bin/env python3
"""ThroughNet Phase-1 gate: raw CSI I/Q capture off UDP 5005 (bypasses server)."""
import socket, struct, sys, time, json, math

phase_name, seconds = sys.argv[1], float(sys.argv[2])
out = f"/tmp/tn-iq-{phase_name}.jsonl"
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("0.0.0.0", 5005))
s.settimeout(1.0)
n = 0
with open(out, "w") as f:
    end = time.time() + seconds
    while time.time() < end:
        try:
            data, addr = s.recvfrom(2048)
        except socket.timeout:
            continue
        if len(data) < 24 or struct.unpack("<I", data[:4])[0] != 0xC5110001:
            continue
        node = data[4]
        nsub = struct.unpack("<H", data[6:8])[0]
        seq  = struct.unpack("<I", data[12:16])[0]
        iq = data[20:20 + nsub * 2]
        if len(iq) < nsub * 2:
            continue
        I = [int.from_bytes(iq[2*k:2*k+1], "little", signed=True) for k in range(nsub)]
        Q = [int.from_bytes(iq[2*k+1:2*k+2], "little", signed=True) for k in range(nsub)]
        f.write(json.dumps({"t": time.time(), "node": node, "seq": seq, "I": I, "Q": Q}) + "\n")
        n += 1
print(f"{phase_name}: captured {n} raw CSI frames -> {out}")
