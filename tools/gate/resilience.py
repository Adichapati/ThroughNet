#!/usr/bin/env python3
"""
ThroughNet R3 — resilience acceptance gates (ROADMAP Phase R).

Turns the two hard robustness requirements into measured pass/fail:

  ip-change   "changing the router / host IP must not break it" — the boards
              rediscover the server via mDNS and streaming auto-recovers.
  add-node    "adding an ESP must not break it" — a newly-powered RX joins the
              fused state without disturbing the nodes already running.

Both gates need exactly one operator action (flip the host IP; power a new
board). The script samples GET /api/v1/throughnet/status before and after, then
scores the outcome. The scoring is pure and verified by --selftest, so the gate
logic itself is trustworthy with no server or hardware present.

Prereq for the live gates: the fleet is streaming and a baseline has been
captured (so nodes report `last_update_ms`); use validate.py to capture one.

Usage:
  python tools/gate/resilience.py --selftest                       # verify scorers, no hw
  python tools/gate/resilience.py --url http://localhost:8080 ip-change
  python tools/gate/resilience.py --url http://localhost:8080 add-node [--out run.json]
"""

import argparse
import json
import sys
import time
import urllib.request

DEFAULT_URL = "http://localhost:8080"

# A node counts as "live" if it reported a frame within this window (ms) and the
# server hasn't flagged it stale. Mirrors the server's FUSION_STALE_AFTER (15 s)
# with margin for poll jitter.
LIVE_WITHIN_MS = 12_000
# Wait budget for streaming to auto-recover after an IP change (s). The firmware
# mDNS watch re-resolves every 30 s; add reconnect + DHCP slack.
RECOVERY_TIMEOUT_S = 90
# Wait budget for a freshly-powered RX to appear and start streaming (s).
ADD_NODE_TIMEOUT_S = 120
POLL_S = 2.0


# ── HTTP + operator helpers (stdlib only) ────────────────────────────────────
def _get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.load(r)


def status(base):
    return _get(base + "/api/v1/throughnet/status")


def prompt(msg):
    try:
        input(f"\n>>> {msg}\n    (press Enter to continue) ")
    except EOFError:
        pass


# ── Pure scoring (exercised by --selftest) ───────────────────────────────────
def live_nodes(st, within_ms=LIVE_WITHIN_MS):
    """Set of node ids currently streaming: a recent frame and not flagged stale."""
    out = set()
    for nid, nd in (st.get("nodes") or {}).items():
        lu = nd.get("last_update_ms")
        if lu is not None and lu <= within_ms and not nd.get("stale", False):
            out.add(nid)
    return out


def score_ip_change(before_live, timeline):
    """Pass if every node live before the IP change is live again by the end of
    the recovery window.

    `before_live` is the set of live node ids captured before the change;
    `timeline` is the list of status snapshots polled afterward. Returns
    (passed, detail).
    """
    if not before_live:
        return False, {
            "error": "no live nodes before the change — start the fleet and "
            "capture a baseline (validate.py) so nodes report frames first"
        }
    final = timeline[-1] if timeline else {}
    recovered = live_nodes(final)
    missing = before_live - recovered
    # Informational: did we observe a real disruption (any poll where a
    # before-node went non-live)? A pass without a dip means nothing broke.
    saw_dip = any(before_live - live_nodes(s) for s in timeline)
    return (not missing), {
        "before_live": sorted(before_live),
        "recovered": sorted(recovered),
        "missing": sorted(missing),
        "observed_disruption": saw_dip,
        "final_state": final.get("state"),
    }


def score_add_node(before, after):
    """Pass if a new node id appeared AND every node live before is still live
    (undisturbed). Returns (passed, detail).
    """
    before_ids = set((before.get("nodes") or {}).keys())
    after_ids = set((after.get("nodes") or {}).keys())
    new_ids = after_ids - before_ids
    before_live = live_nodes(before)
    after_live = live_nodes(after)
    disturbed = before_live - after_live
    new_live = new_ids & after_live
    passed = bool(new_live) and not disturbed
    return passed, {
        "new_nodes": sorted(new_ids),
        "new_nodes_live": sorted(new_live),
        "existing_live_before": sorted(before_live),
        "existing_still_live": sorted(before_live & after_live),
        "disturbed": sorted(disturbed),
        "final_state": after.get("state"),
    }


# ── Live runners ─────────────────────────────────────────────────────────────
def poll_until(base, timeout_s, predicate):
    """Poll status every POLL_S up to timeout_s, printing progress; stop early
    when predicate(snapshot) is True. Returns the list of snapshots collected."""
    timeline = []
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        try:
            st = status(base)
        except Exception as exc:  # noqa: BLE001 — surface any transport error as a snapshot
            st = {"error": str(exc), "nodes": {}, "state": "unreachable"}
        timeline.append(st)
        print(f"  [{int(time.time() - t0):3d}s] state={st.get('state')} "
              f"live={sorted(live_nodes(st))}")
        if predicate(st):
            break
        time.sleep(POLL_S)
    return timeline


def run_ip_change(base):
    print("== IP-change survival gate ==")
    before = live_nodes(status(base))
    print(f"  live nodes now: {sorted(before)}")
    if not before:
        print("  FAIL: no live nodes — start the fleet and capture a baseline "
              "(validate.py) so nodes report frames, then re-run.")
        return False, {"error": "no live nodes before change"}
    prompt("Change the host IP now (renew DHCP, or reassign wlan0), then press Enter.")
    print(f"  waiting up to {RECOVERY_TIMEOUT_S}s for streaming to auto-recover via mDNS...")
    timeline = poll_until(base, RECOVERY_TIMEOUT_S,
                          lambda st: before <= live_nodes(st))
    return score_ip_change(before, timeline)


def run_add_node(base):
    print("== Add-a-node gate ==")
    before = status(base)
    before_ids = set((before.get("nodes") or {}).keys())
    print(f"  nodes now: {sorted(before_ids)} "
          f"(live={sorted(live_nodes(before))}, state={before.get('state')})")
    prompt("Provision + power the NEW RX now "
           "(e.g. provision.py --auto --port <p> --ssid ... ), then press Enter.")
    print(f"  waiting up to {ADD_NODE_TIMEOUT_S}s for the new node to appear + stream...")

    def joined(st):
        new = set((st.get("nodes") or {}).keys()) - before_ids
        return bool(new & live_nodes(st))

    timeline = poll_until(base, ADD_NODE_TIMEOUT_S, joined)
    after = timeline[-1] if timeline else before
    return score_add_node(before, after)


# ── --selftest: verify the scorers deterministically, no server/hardware ─────
def _node(last_update_ms=100, stale=False):
    return {"last_update_ms": last_update_ms, "stale": stale, "present": False}


def _status(nodes, state="present_still"):
    return {"state": state, "nodes": nodes}


def selftest():
    failures = 0

    def check(name, cond):
        nonlocal failures
        print(f"[selftest] {name}: {'PASS' if cond else 'FAIL'}")
        if not cond:
            failures += 1

    # live_nodes: fresh counts, stale + too-old excluded, null excluded.
    st = _status({
        "2": _node(100, False),
        "3": _node(200, True),                 # flagged stale -> not live
        "4": _node(99_999, False),             # too old -> not live
        "5": {"last_update_ms": None, "stale": False},  # pre-baseline -> not live
    })
    check("live_nodes filters stale/old/null", live_nodes(st) == {"2"})

    # ip-change: both nodes recover -> pass; one missing -> fail; empty before -> fail.
    before = {"2", "3"}
    recovered = _status({"2": _node(150), "3": _node(150)})
    dipped = _status({"2": _node(150), "3": _node(99_999)})
    p, _ = score_ip_change(before, [dipped, recovered])
    check("ip-change recovers -> pass", p)
    p, _ = score_ip_change(before, [dipped, dipped])
    check("ip-change node never returns -> fail", not p)
    p, _ = score_ip_change(set(), [recovered])
    check("ip-change with no baseline -> fail", not p)

    # add-node: new node joins live, existing intact -> pass.
    b = _status({"2": _node(100), "3": _node(100)})
    a_ok = _status({"2": _node(100), "3": _node(100), "4": _node(100)})
    a_no_new = _status({"2": _node(100), "3": _node(100)})
    a_disturbed = _status({"2": _node(100), "3": _node(99_999), "4": _node(100)})
    a_new_dead = _status({"2": _node(100), "3": _node(100), "4": _node(99_999)})
    p, _ = score_add_node(b, a_ok)
    check("add-node joins, existing intact -> pass", p)
    p, _ = score_add_node(b, a_no_new)
    check("add-node no new node -> fail", not p)
    p, _ = score_add_node(b, a_disturbed)
    check("add-node disturbs existing -> fail", not p)
    p, _ = score_add_node(b, a_new_dead)
    check("add-node new node not streaming -> fail", not p)

    print(f"\n[selftest] {'ALL PASS' if failures == 0 else f'{failures} FAILURE(S)'}")
    return failures == 0


def main():
    ap = argparse.ArgumentParser(description="ThroughNet R3 resilience gates")
    ap.add_argument("gate", nargs="?", choices=["ip-change", "add-node"],
                    help="which resilience gate to run live")
    ap.add_argument("--url", default=DEFAULT_URL, help=f"server base URL (default {DEFAULT_URL})")
    ap.add_argument("--selftest", action="store_true", help="verify the scorers (no server/hw)")
    ap.add_argument("--out", help="write the result JSON to this path")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(0 if selftest() else 1)

    if not args.gate:
        ap.error("specify a gate (ip-change | add-node) or --selftest")

    runner = {"ip-change": run_ip_change, "add-node": run_add_node}[args.gate]
    passed, detail = runner(args.url)

    print("\n" + "=" * 60)
    print(f"  {args.gate}: {'PASS ✅' if passed else 'FAIL ❌'}")
    for k, v in detail.items():
        print(f"    {k}: {v}")
    print("=" * 60)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump({"gate": args.gate, "passed": passed, "detail": detail}, f, indent=2)
        print(f"  wrote {args.out}")

    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
