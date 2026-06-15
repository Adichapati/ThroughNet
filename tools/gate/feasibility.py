#!/usr/bin/env python3
"""
ThroughNet multi-person feasibility gate (Phase 1).

THE QUESTION this tool answers, cheaply and before any drastic build:
    On the current bistatic rig (1 TX illuminator + 2 RX = 2 links, single-antenna
    ESP32-S3, amplitude-only — phase is unrecoverable, see the Gemini debate notes),
    can the signal even DISTINGUISH 1 person from 2? If not, multi-person tracking is
    dead on arrival and no DSP/ML architecture rescues it (you cannot deep-learn
    information that was never measured).

THE METRIC (agreed with Gemini, then hardened):
    The eigen-spectrum of the JOINT CSI amplitude covariance, whitened against an
    empty-room baseline via a Generalized Eigenvalue Decomposition (GEVD). K people
    moving independently excite K independent multipath-fading processes -> K dominant
    generalized eigenvalues. So:
      * effective rank / lambda_2/lambda_1 rise   -> more independent movers
      * GEVD vs empty whitens static multipath + AGC noise (only dynamic scatterers survive)

    THE CONFOUND (the hardening): one person moving VIGOROUSLY (torso + limbs) also
    excites multiple eigenvalues and can mimic two people on the eigenvalue axis alone.
    So we also compute a SPATIAL axis — the per-link energy split — because two people
    in different zones split fluctuation energy across both links, while one person
    (however vigorous) concentrates it on the link(s) they're near.

THE VERDICT (3-way, locked):
      GO      — a threshold on the eigenvalue axis separates ALL 2-person classes from
                ALL 1-person classes (including 1-vigorous) with usable margin.
      PARTIAL — separation needs the spatial (per-link split) axis too.
      NO-GO   — 1-vigorous and 2-walking-same-zone overlap on BOTH axes => 2 links are
                exhausted; only then is the TDM 3rd link (or stopping) justified.

This tool ADVISES; it prints every number so a human makes the final call. It does not
decide policy.

USAGE
    # 1. With the fleet powered and the sensing-server running (--source esp32):
    python tools/gate/feasibility.py capture --url http://127.0.0.1:8080 \
        --outdir data/feasibility/run1 --seconds 60
    #    (walks you through the 8 ground-truth classes, recording each via the
    #     server's /api/v1/recording API; writes a manifest.json)

    # 2. Offline analysis (no hardware needed):
    python tools/gate/feasibility.py analyze --manifest data/feasibility/run1/manifest.json \
        --out data/feasibility/run1/report.json

    # 3. Self-test the analysis on synthetic CSI (no hardware, no server):
    python tools/gate/feasibility.py --selftest

Requires numpy (the proof pipeline already uses it). Capture uses stdlib urllib only.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.request

import numpy as np

# ── The capture protocol — 8 ground-truth classes ────────────────────────────
# truth_k = number of people; moving = whether they move; the 1-vigorous and
# 1-crossing classes are the adversarial controls for the two discriminant axes.
CLASSES = [
    ("empty",               0, False, "EMPTY ROOM — everyone out. (This is the baseline reference.)"),
    ("1-still",             1, False, "ONE person, standing/sitting STILL near the middle."),
    ("1-walking",           1, True,  "ONE person walking continuously (figure-8s across the room)."),
    ("1-vigorous",          1, True,  "ONE person moving VIGOROUSLY IN PLACE (arms, torso, legs) — the confound."),
    ("1-crossing",          1, True,  "ONE person walking back and forth ACROSS the link boundary (between the two RX lines)."),
    ("2-still-apart",       2, False, "TWO people standing STILL, far apart (one near each RX line)."),
    ("2-walking-apart",     2, True,  "TWO people walking, kept in SEPARATE zones (one near each RX line)."),
    ("2-walking-same-zone", 2, True,  "TWO people walking close together in the SAME zone — the hardest case."),
]
CLASS_TRUTH = {k: (kp, mv) for (k, kp, mv, _) in CLASSES}


# ── CSI parsing ───────────────────────────────────────────────────────────────
def parse_iq_hex(iq_hex: str, n_sub: int) -> np.ndarray:
    """Hex I/Q payload -> per-subcarrier amplitude. Bytes are interleaved signed
    int8 (I0,Q0,I1,Q1,...); amplitude = hypot(I,Q). Null/pilot subcarriers read 0."""
    raw = bytes.fromhex(iq_hex)
    iq = np.frombuffer(raw, dtype=np.int8).astype(np.float64)
    # Trim/pad to 2*n_sub so a malformed length never crashes the run.
    need = 2 * n_sub
    if iq.size < need:
        iq = np.concatenate([iq, np.zeros(need - iq.size)])
    iq = iq[:need]
    i = iq[0::2]
    q = iq[1::2]
    return np.hypot(i, q)


def load_raw_csi(path: str):
    """Read a recording .jsonl -> {node_id: (times[T], amps[T, n_sub])}.
    Only `raw_csi` frames with iq_hex are used; other broadcast messages ignored."""
    per_node: dict[int, list] = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            if r.get("type") != "raw_csi" or "iq_hex" not in r:
                continue
            node = int(r.get("node_id", -1))
            n_sub = int(r.get("subcarriers", 0)) or (len(r["iq_hex"]) // 4)
            try:
                amp = parse_iq_hex(r["iq_hex"], n_sub)
            except ValueError:
                continue
            per_node.setdefault(node, []).append((float(r.get("timestamp", 0.0)), amp))
    out = {}
    for node, rows in per_node.items():
        rows.sort(key=lambda x: x[0])
        times = np.array([t for t, _ in rows], dtype=np.float64)
        amps = np.vstack([a for _, a in rows]) if rows else np.zeros((0, 0))
        out[node] = (times, amps)
    return out


# ── Joint matrix: resample async nodes onto a common grid, concatenate links ──
def build_joint_matrix(per_node, fps: float = 50.0):
    """Resample every node's amplitude series onto a shared uniform time grid over
    their overlapping interval, then concatenate per timestep -> X[T, sum_n_sub].
    Returns (X, link_slices, grid) or (None, ...) if <2 nodes overlap."""
    nodes = sorted(k for k, (t, a) in per_node.items() if t.size > 2 and a.size > 0)
    if len(nodes) < 2:
        return None, {}, None
    t_start = max(per_node[n][0][0] for n in nodes)
    t_end = min(per_node[n][0][-1] for n in nodes)
    if t_end - t_start < 1.0:
        return None, {}, None
    grid = np.arange(t_start, t_end, 1.0 / fps)
    if grid.size < 8:
        return None, {}, None
    cols, slices, c0 = [], {}, 0
    for n in nodes:
        t, a = per_node[n]
        res = np.empty((grid.size, a.shape[1]))
        for j in range(a.shape[1]):
            res[:, j] = np.interp(grid, t, a[:, j])
        cols.append(res)
        slices[n] = (c0, c0 + a.shape[1])
        c0 += a.shape[1]
    return np.hstack(cols), slices, grid


def drop_dead_subcarriers(X, link_slices, ref_floor=1e-6):
    """Drop columns that are ~constant in the baseline (null/pilot subcarriers carry
    no information and inflate dimensionality). Rebuilds link_slices accordingly."""
    keep = X.std(axis=0) > ref_floor
    if keep.sum() < 4:
        return X, link_slices
    newX = X[:, keep]
    new_slices, c0 = {}, 0
    for n, (a, b) in link_slices.items():
        width = int(keep[a:b].sum())
        new_slices[n] = (c0, c0 + width)
        c0 += width
    return newX, new_slices


# ── The eigen-spectrum metrics ────────────────────────────────────────────────
def fluctuation_cov(X: np.ndarray) -> np.ndarray:
    """Covariance of the mean-removed signal — captures DYNAMIC fading (motion);
    the static multipath is the mean and drops out."""
    Xc = X - X.mean(axis=0, keepdims=True)
    n = max(Xc.shape[0] - 1, 1)
    return (Xc.T @ Xc) / n


def gevd_eigenvalues(c_class: np.ndarray, c_empty: np.ndarray, ridge: float = 1e-2) -> np.ndarray:
    """Generalized eigenvalues of  c_class x = lambda c_empty x  (descending).
    Whitening against the empty-room covariance makes lambda represent dynamic
    scatterers normalized by the room's own noise/clutter floor. c_empty is ridged
    to stay SPD (it can be rank-deficient on short / low-rank baselines)."""
    d = c_empty.shape[0]
    tr = max(np.trace(c_empty) / d, 1e-9)
    B = c_empty + ridge * tr * np.eye(d)
    L = np.linalg.cholesky(B)
    Linv = np.linalg.inv(L)
    M = Linv @ c_class @ Linv.T
    M = 0.5 * (M + M.T)
    w = np.linalg.eigvalsh(M)
    return np.sort(np.clip(w, 0.0, None))[::-1]


def eff_rank(eigs: np.ndarray) -> float:
    """Participation ratio (sum^2 / sum-of-squares): a smooth 'number of dominant
    components'. ~1 for one mover, rises toward 2+ as independent movers add."""
    s1 = float(eigs.sum())
    s2 = float((eigs ** 2).sum())
    return (s1 * s1 / s2) if s2 > 0 else 0.0


def link_imbalance(c_class: np.ndarray, link_slices) -> float:
    """|f1 - 0.5| where f1 = fraction of dynamic variance on link 1. 0 = energy split
    evenly across both links (two zones active); 0.5 = all on one link (one zone)."""
    diag = np.clip(np.diag(c_class), 0.0, None)
    per_link = [float(diag[a:b].sum()) for (a, b) in link_slices.values()]
    tot = sum(per_link)
    if tot <= 0 or len(per_link) < 2:
        return 0.5
    f1 = per_link[0] / tot
    return abs(f1 - 0.5)


def window_metrics(X, link_slices, c_empty, win_n, hop_n):
    """Slide a window across X; per window compute (lambda2/lambda1, eff_rank,
    link_imbalance, dyn_energy). Returns a list of dicts (one per window)."""
    out = []
    T = X.shape[0]
    tr_empty = max(np.trace(c_empty), 1e-9)
    for s in range(0, max(T - win_n + 1, 1), hop_n):
        seg = X[s:s + win_n]
        if seg.shape[0] < max(8, win_n // 2):
            continue
        c = fluctuation_cov(seg)
        eigs = gevd_eigenvalues(c, c_empty)
        l1 = float(eigs[0]) if eigs.size else 0.0
        l2 = float(eigs[1]) if eigs.size > 1 else 0.0
        out.append({
            "ratio": (l2 / l1) if l1 > 0 else 0.0,
            "eff_rank": eff_rank(eigs),
            "imbalance": link_imbalance(c, link_slices),
            "dyn_energy": float(np.trace(c) / tr_empty),
        })
    return out


# ── Separability analysis (Fisher discriminant) ───────────────────────────────
def fisher_1d(a: np.ndarray, b: np.ndarray):
    """1D separability of two sample sets: best-threshold accuracy + Fisher ratio +
    signed margin (min(b) - max(a) when b is the 'higher' class)."""
    if a.size == 0 or b.size == 0:
        return {"accuracy": 0.0, "fisher": 0.0, "margin": 0.0, "threshold": 0.0}
    ma, mb = a.mean(), b.mean()
    lo, hi = (a, b) if ma <= mb else (b, a)
    va, vb = a.var() + 1e-12, b.var() + 1e-12
    fisher = (mb - ma) ** 2 / (va + vb)
    cand = np.unique(np.concatenate([a, b]))
    best_acc, best_thr = 0.0, cand[0]
    for thr in cand:
        acc = (np.mean(lo <= thr) * lo.size + np.mean(hi > thr) * hi.size) / (lo.size + hi.size)
        if acc > best_acc:
            best_acc, best_thr = acc, float(thr)
    margin = float(hi.min() - lo.max())  # >0 means fully separated
    return {"accuracy": float(best_acc), "fisher": float(fisher), "margin": margin, "threshold": best_thr}


def fisher_2d(A: np.ndarray, B: np.ndarray):
    """2D Fisher LDA separability: project onto the discriminant direction, then 1D."""
    if A.shape[0] == 0 or B.shape[0] == 0:
        return {"accuracy": 0.0, "fisher": 0.0}
    mA, mB = A.mean(0), B.mean(0)
    Sw = np.cov(A.T) + np.cov(B.T) + 1e-9 * np.eye(A.shape[1])
    w = np.linalg.solve(Sw, mB - mA)
    pa, pb = A @ w, B @ w
    r = fisher_1d(pa, pb)
    return {"accuracy": r["accuracy"], "fisher": r["fisher"]}


def decide(per_class, acc_go=0.90, acc_partial=0.90, min_dyn=1.3):
    """The 3-way go/partial/no-go verdict from per-class window-metric distributions.

    Restricted to MOVING classes and to windows with real motion (dyn_energy >
    min_dyn x the empty floor). This is deliberate and matches the converged
    ceiling: a still person barely perturbs CSI, so multi-person separation is a
    MOVING-target question; static multi-person is a known K=1 ceiling, reported
    but not gated here."""
    def moving_windows(k):
        return [m for m in per_class[k] if m["dyn_energy"] >= min_dyn]

    one = [k for k in per_class if CLASS_TRUTH.get(k, (0, False))[0] == 1
           and CLASS_TRUTH.get(k, (0, False))[1] and moving_windows(k)]
    two = [k for k in per_class if CLASS_TRUTH.get(k, (0, False))[0] == 2
           and CLASS_TRUTH.get(k, (0, False))[1] and moving_windows(k)]
    if not one or not two:
        return {"decision": "inconclusive",
                "reason": "need >=1 moving one-person and >=1 moving two-person class with motion"}

    def pool(keys, field):
        vals = [m[field] for k in keys for m in moving_windows(k)]
        return np.array(vals, dtype=np.float64)

    # Axis 1 — eigenvalue effective rank (primary), ratio reported alongside.
    e1, e2 = pool(one, "eff_rank"), pool(two, "eff_rank")
    axis1 = fisher_1d(e1, e2)
    # Worst-case guard: the hardest 1-person class (e.g. vigorous) must sit below
    # every 2-person class for a clean GO — not just the pooled average.
    one_means = {k: float(np.mean([m["eff_rank"] for m in moving_windows(k)])) for k in one}
    two_means = {k: float(np.mean([m["eff_rank"] for m in moving_windows(k)])) for k in two}
    worst_one = max(one_means, key=one_means.get)
    clean_margin = min(two_means.values()) - max(one_means.values())

    # Axis 2 — add the spatial per-link imbalance.
    A = np.column_stack([pool(one, "eff_rank"), pool(one, "imbalance")])
    B = np.column_stack([pool(two, "eff_rank"), pool(two, "imbalance")])
    axis2 = fisher_2d(A, B)

    if axis1["accuracy"] >= acc_go and clean_margin > 0:
        decision, reason = "go", (
            f"eigenvalue axis separates 1 vs 2 people (acc {axis1['accuracy']:.2f}); "
            f"every 2-person class outranks every 1-person class incl. '{worst_one}' "
            f"(margin {clean_margin:+.2f})")
    elif axis2["accuracy"] >= acc_partial:
        decision, reason = "partial", (
            f"eigenvalue axis alone insufficient (acc {axis1['accuracy']:.2f}, "
            f"'{worst_one}' overlaps the 2-person classes); adding the per-link spatial "
            f"split separates them (2D acc {axis2['accuracy']:.2f})")
    else:
        decision, reason = "no-go", (
            f"neither the eigenvalue axis (acc {axis1['accuracy']:.2f}) nor +spatial "
            f"(2D acc {axis2['accuracy']:.2f}) separates 1 from 2 people — '{worst_one}' "
            "overlaps the 2-person classes on both. 2 links are exhausted; a TDM 3rd "
            "link is the only lever left.")
    return {
        "decision": decision,
        "reason": reason,
        "axis1_eigen": axis1,
        "axis2_eigen_plus_spatial": axis2,
        "clean_margin_eff_rank": float(clean_margin),
        "one_person_eff_rank_means": one_means,
        "two_person_eff_rank_means": two_means,
    }


# ── analyze mode ──────────────────────────────────────────────────────────────
def analyze(manifest_path, out_path, fps, win_s, hop_s, baseline_key="empty"):
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    base_dir = os.path.dirname(os.path.abspath(manifest_path))
    win_n, hop_n = int(round(win_s * fps)), max(int(round(hop_s * fps)), 1)

    # Load every class; build its joint matrix once.
    joints = {}
    for entry in manifest["classes"]:
        key, path = entry["key"], entry["path"]
        if not os.path.isabs(path):
            path = os.path.join(base_dir, path) if os.path.exists(os.path.join(base_dir, path)) else path
        if not os.path.exists(path):
            print(f"  ! missing recording for '{key}': {path}", file=sys.stderr)
            continue
        per_node = load_raw_csi(path)
        X, slices, _ = build_joint_matrix(per_node, fps=fps)
        if X is None:
            print(f"  ! '{key}': <2 nodes streaming / too short — skipped", file=sys.stderr)
            continue
        joints[key] = (X, slices, sorted(per_node.keys()))

    if baseline_key not in joints:
        print(f"ERROR: baseline class '{baseline_key}' missing or unusable.", file=sys.stderr)
        return 2

    # Empty-room reference covariance (over the whole baseline) + dead-subcarrier mask.
    Xe, slices_e, _ = joints[baseline_key]
    Xe, slices_e = drop_dead_subcarriers(Xe, slices_e)
    c_empty = fluctuation_cov(Xe)

    per_class, summary = {}, {}
    for key, (X, slices, nodes) in joints.items():
        # Align this class to the baseline's kept-subcarrier dimensionality.
        Xk, slices_k = drop_dead_subcarriers(X, slices)
        if Xk.shape[1] != c_empty.shape[0]:
            d = min(Xk.shape[1], c_empty.shape[0])
            Xk, ce = Xk[:, :d], c_empty[:d, :d]
        else:
            ce = c_empty
        mets = window_metrics(Xk, slices_k, ce, win_n, hop_n)
        per_class[key] = mets
        if mets:
            summary[key] = {
                "windows": len(mets),
                "nodes": nodes,
                "mean_eff_rank": round(float(np.mean([m["eff_rank"] for m in mets])), 3),
                "mean_lambda2_over_1": round(float(np.mean([m["ratio"] for m in mets])), 3),
                "mean_link_imbalance": round(float(np.mean([m["imbalance"] for m in mets])), 3),
                "mean_dyn_energy": round(float(np.mean([m["dyn_energy"] for m in mets])), 2),
            }

    verdict = decide({k: v for k, v in per_class.items() if v})
    report = {"fps": fps, "window_s": win_s, "hop_s": hop_s, "per_class": summary, "verdict": verdict}

    print("\n=== ThroughNet multi-person feasibility ===")
    print(f"{'class':<22}{'win':>5}{'eff_rank':>10}{'l2/l1':>8}{'imbal':>8}{'dyn_E':>8}")
    for k, _, _, _ in CLASSES:
        if k in summary:
            s = summary[k]
            print(f"{k:<22}{s['windows']:>5}{s['mean_eff_rank']:>10}{s['mean_lambda2_over_1']:>8}"
                  f"{s['mean_link_imbalance']:>8}{s['mean_dyn_energy']:>8}")
    print(f"\nVERDICT: {verdict['decision'].upper()}")
    print(f"  {verdict.get('reason','')}")

    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        print(f"\nreport -> {out_path}")
    return 0 if verdict["decision"] in ("go", "partial") else 1


# ── capture mode ──────────────────────────────────────────────────────────────
def _post(url, body=None):
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def capture(url, outdir, seconds, session):
    os.makedirs(outdir, exist_ok=True)
    rec_dir = os.path.join(os.getcwd(), "data", "recordings")
    print(f"Capture session '{session}': {len(CLASSES)} classes x {seconds}s each.")
    print("Server must be running with --source esp32 and the fleet streaming.\n")
    manifest = {"session": session, "seconds": seconds, "server_url": url, "classes": []}
    for key, truth_k, moving, instruction in CLASSES:
        print("─" * 72)
        print(f"CLASS: {key}   (truth: {truth_k} person{'s' if truth_k != 1 else ''}, "
              f"{'moving' if moving else 'static'})")
        print(f"  SET UP: {instruction}")
        try:
            input("  Press Enter when the room is set and you're ready to record… ")
        except (EOFError, KeyboardInterrupt):
            print("\nAborted.")
            return 1
        rec_id = f"feas_{session}_{key}"
        try:
            _post(url + "/api/v1/recording/start", {"id": rec_id})
        except Exception as e:
            print(f"  ! start failed: {e}", file=sys.stderr)
            return 1
        for rem in range(seconds, 0, -1):
            print(f"  recording… {rem:>3}s remaining ", end="\r", flush=True)
            time.sleep(1)
        try:
            res = _post(url + "/api/v1/recording/stop")
        except Exception as e:
            print(f"\n  ! stop failed: {e}", file=sys.stderr)
            return 1
        path = os.path.join(rec_dir, f"{rec_id}.jsonl")
        frames = res.get("frames")
        print(f"\n  done: {rec_id} ({res.get('duration_secs','?')}s)")
        manifest["classes"].append({
            "key": key, "truth_k": truth_k, "moving": moving,
            "recording_id": rec_id, "path": path, "frames": frames,
        })
    mpath = os.path.join(outdir, "manifest.json")
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print("─" * 72)
    print(f"Capture complete. manifest -> {mpath}")
    print(f"Now analyze:\n  python tools/gate/feasibility.py analyze --manifest {mpath}")
    return 0


# ── selftest (synthetic CSI, no hardware) ─────────────────────────────────────
def _synth_class(rng, kind, fps=50.0, dur=40.0, n_sub=56, noise=0.6):
    """Synthesize per-node amplitude series for a class. Each 'mover' is an
    independent smooth fading process; subcarriers mix the movers with random
    weights. 'vigorous' = one mover whose response is rank-2 but spatially
    concentrated on one link (the confound)."""
    T = int(dur * fps)
    t = np.arange(T) / fps

    def mover(freqs):
        g = np.zeros(T)
        for fr in freqs:
            g += np.sin(2 * np.pi * fr * t + rng.uniform(0, 2 * np.pi))
        return g / max(len(freqs), 1)

    def emit(weight_n1, weight_n2, procs):
        # procs: list of (process[T], col-weight-vector[n_sub] for each link)
        n1 = np.zeros((T, n_sub))
        n2 = np.zeros((T, n_sub))
        for g, w1, w2 in procs:
            n1 += np.outer(g, w1) * weight_n1
            n2 += np.outer(g, w2) * weight_n2
        n1 += rng.normal(0, noise, (T, n_sub))
        n2 += rng.normal(0, noise, (T, n_sub))
        base = 40.0  # static multipath offset (removed by mean-subtraction anyway)
        return base + n1, base + n2

    def w():  # a random subcarrier response vector
        return rng.normal(0, 1, n_sub)

    if kind == "empty":
        procs1 = []
    elif kind == "1-still":
        g = mover([0.3]) * 0.4  # tiny (breathing-like)
        procs1 = [(g, w() * 2.0, w() * 2.0)]
    elif kind == "1-walking":
        g = mover([1.2]) * 3.0
        procs1 = [(g, w() * 4.0, w() * 3.0)]
    elif kind == "1-vigorous":
        # one body but TWO sub-processes (limbs) -> rank-2 eigen-signature (confound),
        # yet both concentrated on link 1 (person stands near RX1) -> imbalanced split.
        g1 = mover([1.5, 3.0]) * 4.0
        g2 = mover([2.2]) * 3.0
        procs1 = [(g1, w() * 5.0, w() * 0.6), (g2, w() * 4.5, w() * 0.5)]
    elif kind == "1-crossing":
        g = mover([1.0]) * 3.0
        procs1 = [(g, w() * 3.0, w() * 3.0)]  # energy roughly balanced mid-crossing
    elif kind == "2-still-apart":
        g1 = mover([0.3]) * 0.5
        g2 = mover([0.35]) * 0.5
        procs1 = [(g1, w() * 2.2, w() * 0.4), (g2, w() * 0.4, w() * 2.2)]
    elif kind == "2-walking-apart":
        g1 = mover([1.1]) * 3.5
        g2 = mover([1.6]) * 3.5
        procs1 = [(g1, w() * 4.0, w() * 0.6), (g2, w() * 0.6, w() * 4.0)]
    elif kind == "2-walking-same-zone":
        g1 = mover([1.3]) * 3.5
        g2 = mover([1.8]) * 3.5
        procs1 = [(g1, w() * 4.0, w() * 0.7), (g2, w() * 3.6, w() * 0.7)]
    else:
        procs1 = []

    a1, a2 = emit(1.0, 1.0, procs1)
    return {
        1: (t + 1000.0, a1),
        2: (t + 1000.0 + rng.uniform(0, 0.01), a2),  # slight async offset, like real nodes
    }


def selftest():
    rng = np.random.default_rng(42)
    fps, win_s, hop_s = 50.0, 1.75, 0.5
    win_n, hop_n = int(win_s * fps), int(hop_s * fps)

    joints = {}
    for key, _, _, _ in CLASSES:
        per_node = _synth_class(rng, key, fps=fps)
        X, slices, _ = build_joint_matrix(per_node, fps=fps)
        assert X is not None, f"joint matrix failed for {key}"
        joints[key] = drop_dead_subcarriers(X, slices)

    c_empty = fluctuation_cov(joints["empty"][0])
    per_class, eff = {}, {}
    for key, (X, slices) in joints.items():
        mets = window_metrics(X, slices, c_empty, win_n, hop_n)
        per_class[key] = mets
        eff[key] = float(np.mean([m["eff_rank"] for m in mets]))
        print(f"  {key:<22} eff_rank={eff[key]:.3f}  "
              f"l2/l1={np.mean([m['ratio'] for m in mets]):.3f}  "
              f"imbal={np.mean([m['imbalance'] for m in mets]):.3f}")

    ratio = {k: float(np.mean([m["ratio"] for m in per_class[k]])) for k in eff}
    imb = {k: float(np.mean([m["imbalance"] for m in per_class[k]])) for k in eff}

    # 1. Whitening sanity: empty (whitened against itself) is FLAT -> high lambda2/lambda1;
    #    one strong mover concentrates into one direction -> ~0.
    assert ratio["empty"] > ratio["1-walking"], \
        f"empty ratio {ratio['empty']:.3f} should exceed 1-walking {ratio['1-walking']:.3f}"
    # 2. Among MOVING targets, two independent movers out-rank one (the core signal).
    assert eff["2-walking-apart"] > eff["1-walking"], "2 movers should out-rank 1 mover (eff_rank)"
    assert eff["2-walking-same-zone"] > eff["1-walking"], "2 movers (same zone) should still out-rank 1"
    # 3. The confound is real: one VIGOROUS mover inflates eff_rank into the 2-person
    #    range — exactly why the eigenvalue axis alone is insufficient.
    assert eff["1-vigorous"] > eff["1-walking"], "vigorous single mover should inflate eff_rank"
    # 4. The spatial axis rescues the clean case: two people APART split energy across
    #    links (low imbalance) while one vigorous body concentrates it (high imbalance).
    assert imb["1-vigorous"] > imb["2-walking-apart"], \
        f"vigorous imbalance {imb['1-vigorous']:.3f} should exceed 2-apart {imb['2-walking-apart']:.3f}"
    # 5. Machinery: the full verdict runs and returns a valid 3-way decision, AND on a
    #    CLEAN subset (drop the two adversarial classes) the GO path is reachable.
    full = decide({k: v for k, v in per_class.items() if v})
    clean = decide({k: v for k, v in per_class.items()
                    if v and k not in ("1-vigorous", "2-walking-same-zone")})
    print(f"\n  full verdict:  {full['decision'].upper()} — {full['reason']}")
    print(f"  clean subset:  {clean['decision'].upper()} — {clean['reason']}")
    assert full["decision"] in ("go", "partial", "no-go"), f"invalid verdict {full['decision']}"
    assert clean["decision"] in ("go", "partial"), \
        f"clean separable subset should be go/partial, got {clean['decision']}"

    print("\nselftest PASS (6/6 checks)")
    return 0


# ── CLI ───────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description="ThroughNet multi-person feasibility gate (Phase 1).")
    ap.add_argument("--selftest", action="store_true", help="run synthetic-CSI self-test and exit")
    sub = ap.add_subparsers(dest="cmd")

    cap = sub.add_parser("capture", help="record the 8 ground-truth classes via the server")
    cap.add_argument("--url", default="http://127.0.0.1:8080")
    cap.add_argument("--outdir", default="data/feasibility/run1")
    cap.add_argument("--seconds", type=int, default=60)
    cap.add_argument("--session", default="r1")

    an = sub.add_parser("analyze", help="analyze a captured manifest -> go/partial/no-go")
    an.add_argument("--manifest", required=True)
    an.add_argument("--out", default=None)
    an.add_argument("--fps", type=float, default=50.0)
    an.add_argument("--window-s", type=float, default=1.75)
    an.add_argument("--hop-s", type=float, default=0.5)

    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if args.cmd == "capture":
        return capture(args.url, args.outdir, args.seconds, args.session)
    if args.cmd == "analyze":
        return analyze(args.manifest, args.out, args.fps, args.window_s, args.hop_s)
    ap.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
