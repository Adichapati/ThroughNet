// Transport to the sensing-server. Polls GET /api/v1/throughnet/status (the
// authoritative ThroughNet verdict — computed in the server's REST handler) and
// maps it to the typed shapes the UI renders. Served same-origin in production
// (server-as-shell, ADR-151); in dev, Vite proxies /api -> 127.0.0.1:8080.
//
// JSON contract (from sensing-server src/main.rs throughnet_status):
//   { state, breathing_bpm, breathing_confidence, capturing_baseline,
//     nodes: { "<id>": { baseline, baseline_age_s, presence_score, motion_score,
//                        present, moving, stale, breathing_bpm,
//                        breathing_confidence, last_update_ms } } }
import type { SensingState } from './types';

export type FusedState = 'absent' | 'present_still' | 'present_moving' | 'no_baseline_or_data';
export type ConnState = 'connecting' | 'live' | 'offline';

export interface NodeStatus {
  id: string;
  baseline: boolean;
  baselineAgeS: number | null;
  presenceScore: number;
  motionScore: number;
  present: boolean;
  moving: boolean;
  stale: boolean;
  breathingBpm: number | null;
  breathingConfidence: number | null;
  lastUpdateMs: number | null;
}

export interface ThroughnetStatus {
  state: FusedState;
  breathingBpm: number | null;
  breathingConfidence: number | null;
  capturingBaseline: boolean;
  nodes: NodeStatus[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);

export function parseStatus(j: any): ThroughnetStatus {
  const nodesObj = (j && j.nodes) || {};
  const nodes: NodeStatus[] = Object.keys(nodesObj)
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => {
      const n = nodesObj[id] || {};
      return {
        id,
        baseline: !!n.baseline,
        baselineAgeS: num(n.baseline_age_s),
        presenceScore: num(n.presence_score) ?? 0,
        motionScore: num(n.motion_score) ?? 0,
        present: !!n.present,
        moving: !!n.moving,
        stale: !!n.stale,
        breathingBpm: num(n.breathing_bpm),
        breathingConfidence: num(n.breathing_confidence),
        lastUpdateMs: num(n.last_update_ms),
      };
    });
  return {
    state: (j && j.state) || 'no_baseline_or_data',
    breathingBpm: num(j && j.breathing_bpm),
    breathingConfidence: num(j && j.breathing_confidence),
    capturingBaseline: !!(j && j.capturing_baseline),
    nodes,
  };
}

// Map the live verdict to the diorama's SensingState. A non-present state (incl.
// no_baseline_or_data / offline) renders as an empty room; bpm falls back so the
// breathing animation has a sane rate when it next appears.
export function toSensingState(s: ThroughnetStatus | null, lastBpm = 15): SensingState {
  if (!s) return { present: false, moving: false, breathing: false, bpm: lastBpm };
  const present = s.state === 'present_still' || s.state === 'present_moving';
  const moving = s.state === 'present_moving';
  const breathing = s.state === 'present_still' && s.breathingBpm != null;
  return { present, moving, breathing, bpm: s.breathingBpm ?? lastBpm };
}

export class TnClient {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly onUpdate: (status: ThroughnetStatus | null, conn: ConnState) => void,
    private readonly url = '/api/v1/throughnet/status',
    private readonly intervalMs = 1000,
  ) {}

  start() { this.stopped = false; this.tick(); }

  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }

  private async tick() {
    try {
      const res = await fetch(this.url, { headers: { accept: 'application/json' } });
      if (res.ok) this.onUpdate(parseStatus(await res.json()), 'live');
      else this.onUpdate(null, 'offline');
    } catch {
      this.onUpdate(null, 'offline');
    }
    if (!this.stopped) this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }
}
