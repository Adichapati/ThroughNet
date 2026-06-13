#!/usr/bin/env python3
"""ThroughNet Phase-2 validation harness.

Drives the sensing-server ThroughNet endpoints through scripted ground-truth
phases and scores the run against the Phase-2 acceptance gates. This is the
tool that turns "it looked right when I watched it" into measured numbers — every
detector/threshold change re-runs this suite (ROADMAP §4, Phase 2 item 5).

Protocol (interactive — needs one person + the 3-board fleet streaming):

  baseline    room EMPTY  -> POST /throughnet/baseline/start..stop (freeze ref)
  empty       room EMPTY  -> expect `absent`           (presence false-positive)
  enter_still enter, hold still -> expect `present_still` (detection + latency)
  moving      walk, cross the links -> expect `present_moving` (motion discrim)
  exit        leave        -> expect `absent`           (exit latency, informational)

Gates (ROADMAP §4 Phase-2 acceptance):
  presence false-positive (empty room)          < 5 %
  presence detection      (occupied, settled)   > 95 %
  presence latency        (enter -> first detect)  < 10 s
  motion still-vs-moving discrimination (5 s win) > 90 %

Reuses only the existing REST API — no server changes. Start the sensing-server
first (it owns UDP 5005); this talks to its HTTP API (default :8080).

  python tools/gate/validate.py                       # full interactive run
  python tools/gate/validate.py --quick               # shorter phases
  python tools/gate/validate.py --check               # just ping the server
  python tools/gate/validate.py --selftest            # verify the scorers (no hw)
  python tools/gate/validate.py --url http://host:8080 --out run.json
"""
import argparse
import json
import sys
import time
import urllib.request
from collections import defaultdict

# Fused states the detector can report (GET /api/v1/throughnet/status -> "state").
REAL_STATES = {"absent", "present_still", "present_moving"}
PRESENT_STATES = {"present_still", "present_moving"}

# metric -> (comparison, threshold). A run PASSes only if every gate passes.
GATES = {
    "presence_fp": ("<", 0.05),
    "presence_detection": (">", 0.95),
    "enter_latency_s": ("<", 10.0),
    "motion_discrimination": (">", 0.90),
}

# Seconds after a phase boundary to ignore when scoring steady-state metrics:
# the debounce needs ~2 windows (~4 s) to commit and the operator needs a moment
# to settle into the posture. Latency is measured separately on the transient.
SETTLE_S = 10.0
WINDOW_S = 5.0  # motion-discrimination window length (acceptance spec: 5 s)


# ── HTTP helpers (stdlib only, like the rest of tools/gate) ──────────────────
def _get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.load(r)


def _post(url):
    req = urllib.request.Request(url, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


def status(base):
    return _get(base + "/api/v1/throughnet/status")


# ── Pure scoring functions (exercised by --selftest) ─────────────────────────
def _valid(samples, label):
    return [s for s in samples if s["label"] == label and s["state"] in REAL_STATES]


def score_presence_fp(samples):
    """Fraction of empty-phase samples that are NOT `absent` (lower is better)."""
    empty = _valid(samples, "empty")
    if not empty:
        return None
    return sum(1 for s in empty if s["state"] != "absent") / len(empty)


def score_enter_latency(samples, t_enter):
    """Seconds from entry to the first `present_*` sample (None = never detected)."""
    occ = sorted(
        (s for s in samples if s["label"] == "enter_still"), key=lambda s: s["t"]
    )
    for s in occ:
        if s["state"] in PRESENT_STATES:
            return s["t"] - t_enter
    return None


def score_presence_detection(samples, t_enter):
    """Fraction of settled occupied samples reading `present_*` (higher is better)."""
    occ = [
        s
        for s in samples
        if s["state"] in REAL_STATES
        and (
            (s["label"] == "enter_still" and s["t"] >= t_enter + SETTLE_S)
            or s["label"] == "moving"
        )
    ]
    if not occ:
        return None
    return sum(1 for s in occ if s["state"] in PRESENT_STATES) / len(occ)


def score_motion_discrimination(samples, phase_starts):
    """Per-5 s-window still-vs-moving accuracy. Returns (accuracy, n_windows)."""
    results = []  # (truth_moving, predicted_moving)
    for label, truth_moving in (("enter_still", False), ("moving", True)):
        start = phase_starts.get(label)
        if start is None:
            continue
        seg = [
            s
            for s in samples
            if s["label"] == label
            and s["state"] in REAL_STATES
            and s["t"] >= start + SETTLE_S
        ]
        if not seg:
            continue
        t0 = seg[0]["t"]
        buckets = defaultdict(list)
        for s in seg:
            buckets[int((s["t"] - t0) // WINDOW_S)].append(s)
        for ws in buckets.values():
            moving_votes = sum(1 for s in ws if s["state"] == "present_moving")
            pred_moving = moving_votes * 2 >= len(ws)  # majority of the window
            results.append((truth_moving, pred_moving))
    if not results:
        return None, 0
    correct = sum(1 for tm, pm in results if tm == pm)
    return correct / len(results), len(results)


def score_exit_latency(samples, t_exit):
    """Seconds from the exit cue to the first `absent` (informational)."""
    seg = sorted((s for s in samples if s["label"] == "exit"), key=lambda s: s["t"])
    for s in seg:
        if s["state"] == "absent":
            return s["t"] - t_exit
    return None


def gate_pass(metric, value):
    if value is None or metric not in GATES:
        return None
    comp, thr = GATES[metric]
    return value < thr if comp == "<" else value > thr


def compute_scores(samples, phase_starts):
    t_enter = phase_starts.get("enter_still", 0.0)
    t_exit = phase_starts.get("exit", 0.0)
    motion_acc, motion_n = score_motion_discrimination(samples, phase_starts)
    return {
        "presence_fp": score_presence_fp(samples),
        "presence_detection": score_presence_detection(samples, t_enter),
        "enter_latency_s": score_enter_latency(samples, t_enter),
        "motion_discrimination": motion_acc,
        "motion_windows": motion_n,
        "exit_latency_s": score_exit_latency(samples, t_exit),
    }


# ── Interactive run ──────────────────────────────────────────────────────────
def countdown(seconds, label, base, samples):
    """Poll status ~2 Hz for `seconds`, appending labeled samples; live feedback."""
    start = time.time()
    end = start + seconds
    last_print = 0.0
    while time.time() < end:
        t = time.time()
        try:
            st = status(base)
            state = st.get("state")
            nodes = st.get("nodes", {})
        except Exception as e:  # noqa: BLE001 — surface, don't crash the run
            state, nodes = "error", {"error": str(e)}
        samples.append({"t": t, "label": label, "state": state, "nodes": nodes})
        if t - last_print >= 1.0:
            remaining = int(end - t)
            scores = []
            for n, nd in sorted(nodes.items()) if isinstance(nodes, dict) else []:
                if isinstance(nd, dict) and nd.get("presence_score") is not None:
                    scores.append(
                        f"n{n} P{nd['presence_score']:.1f} "
                        f"M{(nd.get('motion_score') or 0):.1f}"
                    )
            print(
                f"  [{label:11s}] {remaining:3d}s  state={state:14s} "
                f"{' '.join(scores)}",
                flush=True,
            )
            last_print = t
        time.sleep(0.5)
    return start


def prompt(msg):
    try:
        input(f"\n>>> {msg}\n    Press Enter when ready... ")
    except (EOFError, KeyboardInterrupt):
        print("\nAborted.")
        sys.exit(130)


def capture_baseline(base, seconds):
    prompt("Leave the room and shut the door — capturing the EMPTY-ROOM baseline.")
    r = _post(base + "/api/v1/throughnet/baseline/start")
    if not r.get("success"):
        print(f"  baseline/start failed: {r}")
        sys.exit(1)
    print(f"  capturing baseline for {int(seconds)}s — stay out of the room...")
    time.sleep(seconds)
    r = _post(base + "/api/v1/throughnet/baseline/stop")
    nodes = r.get("nodes", {})
    for n, info in sorted(nodes.items()):
        ok = info.get("success")
        if ok:
            print(f"  node {n}: baseline OK ({info.get('frames')} frames, "
                  f"{info.get('windows')} windows)")
        else:
            print(f"  node {n}: baseline FAILED — {info.get('error')}")
    if not r.get("success"):
        print("  No node produced a usable baseline. Check the fleet is streaming "
              "(tools/gate/link_meter.py) and re-run.")
        sys.exit(1)


def run_protocol(base, durations):
    samples = []
    phase_starts = {}

    print("\n=== ThroughNet Phase-2 validation ===")
    print(f"server: {base}")
    try:
        st = status(base)
    except Exception as e:  # noqa: BLE001
        print(f"Cannot reach the sensing-server at {base}: {e}\n"
              "Start it first (it owns UDP 5005), then re-run.")
        sys.exit(1)
    print(f"initial state: {st.get('state')}  "
          f"(nodes seen: {len(st.get('nodes', {}))})")

    capture_baseline(base, durations["baseline"])

    prompt("Keep the room EMPTY. Measuring presence false-positive rate.")
    phase_starts["empty"] = countdown(durations["empty"], "empty", base, samples)

    prompt("ENTER the room and stand as STILL as you can (chest height to a link).")
    phase_starts["enter_still"] = countdown(
        durations["enter_still"], "enter_still", base, samples
    )

    prompt("Now WALK around — cross the lines between the boards repeatedly.")
    phase_starts["moving"] = countdown(durations["moving"], "moving", base, samples)

    prompt("LEAVE the room and shut the door.")
    phase_starts["exit"] = countdown(durations["exit"], "exit", base, samples)

    return samples, phase_starts


def print_scorecard(scores):
    rows = [
        ("presence_fp", "Presence false-positive (empty)", "{:.1%}"),
        ("presence_detection", "Presence detection (occupied)", "{:.1%}"),
        ("enter_latency_s", "Presence latency (enter->detect)", "{:.1f}s"),
        ("motion_discrimination", "Motion still-vs-moving (5s win)", "{:.1%}"),
    ]
    print("\n" + "=" * 60)
    print("  PHASE-2 SCORECARD")
    print("=" * 60)
    overall = True
    for metric, label, fmt in rows:
        val = scores.get(metric)
        passed = gate_pass(metric, val)
        comp, thr = GATES[metric]
        thr_str = (f"{thr:.0%}" if "fp" in metric or "detection" in metric
                   or "discrim" in metric else f"{thr:.0f}s")
        if val is None:
            verdict, shown = "NO DATA", "  —  "
            overall = False
        else:
            verdict = "PASS" if passed else "FAIL"
            shown = fmt.format(val)
            overall = overall and bool(passed)
        print(f"  {label:34s} {shown:>8s}  (gate {comp}{thr_str:>4s})  {verdict}")
    nwin = scores.get("motion_windows", 0)
    exitl = scores.get("exit_latency_s")
    print("-" * 60)
    print(f"  motion windows scored: {nwin}    "
          f"exit latency: {('%.1fs' % exitl) if exitl is not None else '—'}")
    print("=" * 60)
    print(f"  OVERALL: {'PASS ✅' if overall else 'FAIL ❌'}")
    print("=" * 60)
    return overall


# ── --selftest: verify the scorers deterministically, no server/hardware ─────
def _synth_run(fp_blips=1, enter_detect_offset=3.0, still_clean=True,
               moving_clean=True):
    """Build a labeled sample stream for the scorers. Times are synthetic."""
    samples, starts = [], {}
    t = 0.0

    def add(label, state, n):
        nonlocal t
        for _ in range(n):
            samples.append({"t": t, "label": label, "state": state, "nodes": {}})
            t += 0.5

    starts["empty"] = t
    add("empty", "absent", 60)
    # inject a few spurious non-absent blips into the empty phase
    for i in range(fp_blips):
        samples.append({"t": starts["empty"] + i, "label": "empty",
                        "state": "present_still", "nodes": {}})

    starts["enter_still"] = t
    # absent until the detection offset, then present_still for the rest
    n_absent = int(enter_detect_offset / 0.5)
    add("enter_still", "absent", n_absent)
    add("enter_still", "present_still" if still_clean else "present_moving", 80)

    starts["moving"] = t
    add("moving", "present_moving" if moving_clean else "present_still", 80)

    starts["exit"] = t
    add("exit", "present_moving", 4)
    add("exit", "absent", 40)
    return samples, starts


def selftest():
    failures = 0

    # 1. A clean run must PASS every gate.
    s, st = _synth_run()
    sc = compute_scores(s, st)
    clean_ok = (gate_pass("presence_fp", sc["presence_fp"])
                and gate_pass("presence_detection", sc["presence_detection"])
                and gate_pass("enter_latency_s", sc["enter_latency_s"])
                and gate_pass("motion_discrimination", sc["motion_discrimination"]))
    print(f"[selftest] clean run -> {sc}")
    if not clean_ok:
        print("  FAIL: clean run should pass all gates"); failures += 1

    # 2. Latency just under budget passes; over budget fails.
    s, st = _synth_run(enter_detect_offset=4.0)
    assert gate_pass("enter_latency_s", compute_scores(s, st)["enter_latency_s"])
    s, st = _synth_run(enter_detect_offset=14.0)
    if gate_pass("enter_latency_s", compute_scores(s, st)["enter_latency_s"]):
        print("  FAIL: 14s latency should fail the <10s gate"); failures += 1

    # 3. Many empty-room blips must trip the false-positive gate.
    s, st = _synth_run(fp_blips=40)
    if gate_pass("presence_fp", compute_scores(s, st)["presence_fp"]):
        print("  FAIL: 40 blips should fail the <5% FP gate"); failures += 1

    # 4. Mislabeled motion (still reads moving, moving reads still) must fail discrim.
    s, st = _synth_run(still_clean=False, moving_clean=False)
    acc = compute_scores(s, st)["motion_discrimination"]
    if acc is None or gate_pass("motion_discrimination", acc):
        print(f"  FAIL: inverted motion should fail discrim (got {acc})"); failures += 1

    # 5. Empty stream -> metrics are None (no crash, reported as NO DATA).
    none_scores = compute_scores([], {})
    if none_scores["presence_fp"] is not None:
        print("  FAIL: empty input should yield None metrics"); failures += 1

    print(f"\n[selftest] {'ALL PASS ✅' if failures == 0 else f'{failures} FAILURE(S) ❌'}")
    return failures == 0


def main():
    ap = argparse.ArgumentParser(description="ThroughNet Phase-2 validation harness")
    ap.add_argument("--url", default="http://127.0.0.1:8080",
                    help="sensing-server HTTP base URL (default :8080)")
    ap.add_argument("--quick", action="store_true",
                    help="shorter phases for a smoke run")
    ap.add_argument("--check", action="store_true",
                    help="just ping the status endpoint and exit")
    ap.add_argument("--selftest", action="store_true",
                    help="verify the scoring functions (no server/hardware needed)")
    ap.add_argument("--out", default=None,
                    help="write the full run (samples + scores) to this JSON file")
    args = ap.parse_args()

    if args.selftest:
        sys.exit(0 if selftest() else 1)

    base = args.url.rstrip("/")

    if args.check:
        try:
            st = status(base)
            print(f"OK — {base} reachable. state={st.get('state')} "
                  f"nodes={list(st.get('nodes', {}).keys())} "
                  f"capturing={st.get('capturing_baseline')}")
            sys.exit(0)
        except Exception as e:  # noqa: BLE001
            print(f"UNREACHABLE — {base}: {e}")
            sys.exit(1)

    full = {"baseline": 30, "empty": 30, "enter_still": 45, "moving": 45, "exit": 30}
    quick = {"baseline": 20, "empty": 15, "enter_still": 25, "moving": 25, "exit": 15}
    durations = quick if args.quick else full

    samples, phase_starts = run_protocol(base, durations)
    scores = compute_scores(samples, phase_starts)
    overall = print_scorecard(scores)

    if args.out:
        with open(args.out, "w") as f:
            json.dump(
                {
                    "ts": time.time(),
                    "url": base,
                    "durations": durations,
                    "phase_starts": phase_starts,
                    "scores": scores,
                    "samples": samples,
                },
                f,
                indent=2,
            )
        print(f"\nwrote {len(samples)} samples + scores -> {args.out}")

    sys.exit(0 if overall else 1)


if __name__ == "__main__":
    main()
