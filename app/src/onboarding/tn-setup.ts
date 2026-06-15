// In-app setup transport (ADR-151 A3). The onboarding "prepare" step calls the
// server's localhost-only host preflight; scan/flash/provision (the hardware-
// gated steps) join this module as they land. Served same-origin in production
// (server-as-shell); in dev, Vite proxies /api -> 127.0.0.1:8080.
//
// JSON contract (sensing-server src/main.rs setup_doctor):
//   { ok, checks: [ { id, label, status: ok|warn|fail|info, detail, fix } ] }

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  fix: string | null;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

const STATUSES: DoctorStatus[] = ['ok', 'warn', 'fail', 'info'];

export async function fetchDoctor(url = '/api/v1/setup/doctor'): Promise<DoctorReport> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`doctor ${res.status}`);
  const j: any = await res.json();
  const checks: DoctorCheck[] = Array.isArray(j?.checks)
    ? j.checks.map((c: any) => ({
        id: String(c?.id ?? ''),
        label: String(c?.label ?? ''),
        status: (STATUSES.includes(c?.status) ? c.status : 'info') as DoctorStatus,
        detail: String(c?.detail ?? ''),
        fix: c?.fix == null ? null : String(c.fix),
      }))
    : [];
  return { ok: !!j?.ok, checks };
}

// ── scan / flash / provision (the hardware steps) ─────────────────────────────

export interface ScanPort {
  path: string;
  chip: string | null;
  flashSize: string | null;
  mac: string | null;
  ok: boolean;
  error: string | null;
}

export async function scanPorts(url = '/api/v1/setup/scan'): Promise<ScanPort[]> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`scan ${res.status}`);
  const j: any = await res.json();
  return (Array.isArray(j?.ports) ? j.ports : []).map((p: any) => ({
    path: String(p?.path ?? ''),
    chip: p?.chip ?? null,
    flashSize: p?.flash_size ?? null,
    mac: p?.mac ?? null,
    ok: !!p?.ok,
    error: p?.error ?? null,
  }));
}

export interface FlashResult {
  success: boolean;
  port?: string;
  elapsedS?: number;
  error?: string;
}

export async function flashBoard(port: string, url = '/api/v1/setup/flash'): Promise<FlashResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ port }),
  });
  const j: any = await res.json().catch(() => ({}));
  return { success: !!j?.success, port: j?.port, elapsedS: j?.elapsed_s, error: j?.error };
}

export interface ProvisionResult {
  success: boolean;
  role?: string | null;
  nodeId?: number | null;
  error?: string;
}

export async function provisionBoard(
  req: { port: string; ssid?: string; password?: string; targetIp?: string; role?: string },
  url = '/api/v1/setup/provision',
): Promise<ProvisionResult> {
  // snake_case the wire fields the server expects (target_ip); role is forwarded
  // verbatim ('tx' | 'rx') so the Devices console can assign the illuminator.
  const body: Record<string, string> = { port: req.port };
  if (req.ssid) body.ssid = req.ssid;
  if (req.password) body.password = req.password;
  if (req.targetIp) body.target_ip = req.targetIp;
  if (req.role) body.role = req.role;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const j: any = await res.json().catch(() => ({}));
  return { success: !!j?.success, role: j?.role ?? null, nodeId: j?.node_id ?? null, error: j?.error };
}

// Used in ?mock (serverless demos) so the steps still have content.
export const MOCK_SCAN: ScanPort[] = [
  { path: '/dev/ttyACM0', chip: 'ESP32-S3', flashSize: '16MB', mac: '3c:0f:02:d7:4a:60', ok: true, error: null },
];

// ── fleet reconciler (state ∪ live) ───────────────────────────────────────────
// The single source of truth for "what's already set up", so onboarding stops
// telling users to re-flash working boards. JSON contract: sensing-server
// setup_fleet — { summary: {known,online,tx_online,rx_online,healthy,scanned},
//   devices: [{ node_id, role, bucket, present, online, port, chip, ... }] }.

export type DeviceBucket = 'streaming' | 'provisioned' | 'unprovisioned';

export interface FleetDevice {
  nodeId: number | null;
  role: string | null;       // 'tx' | 'rx' | 'legacy' | null
  bucket: DeviceBucket;
  provisioned: boolean;
  present: boolean;          // plugged into this machine right now (needs ?scan)
  online: boolean;           // streaming fresh CSI frames
  port: string | null;
  chip: string | null;
  flashSize: string | null;
  ssid: string | null;
  rssiDbm: number | null;
  csiFps: number | null;
  lastSeenS: number | null;
}

export interface FleetSummary {
  known: number;
  online: number;
  txOnline: number;
  rxOnline: number;
  healthy: boolean;          // ≥1 TX + ≥1 RX streaming
  scanned: boolean;
}

export interface FleetReport {
  summary: FleetSummary;
  devices: FleetDevice[];
}

const BUCKETS: DeviceBucket[] = ['streaming', 'provisioned', 'unprovisioned'];

export async function fetchFleet(scan = false, base = '/api/v1/setup/fleet'): Promise<FleetReport> {
  const url = scan ? `${base}?scan=true` : base;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`fleet ${res.status}`);
  const j: any = await res.json();
  const s = j?.summary ?? {};
  const devices: FleetDevice[] = (Array.isArray(j?.devices) ? j.devices : []).map((d: any) => ({
    nodeId: typeof d?.node_id === 'number' ? d.node_id : null,
    role: d?.role ?? null,
    bucket: (BUCKETS.includes(d?.bucket) ? d.bucket : 'unprovisioned') as DeviceBucket,
    provisioned: !!d?.provisioned,
    present: !!d?.present,
    online: !!d?.online,
    port: d?.port ?? null,
    chip: d?.chip ?? null,
    flashSize: d?.flash_size ?? null,
    ssid: d?.ssid ?? null,
    rssiDbm: typeof d?.rssi_dbm === 'number' ? d.rssi_dbm : null,
    csiFps: typeof d?.csi_fps === 'number' ? d.csi_fps : null,
    lastSeenS: typeof d?.last_seen_s === 'number' ? d.last_seen_s : null,
  }));
  return {
    summary: {
      known: Number(s?.known ?? 0),
      online: Number(s?.online ?? 0),
      txOnline: Number(s?.tx_online ?? 0),
      rxOnline: Number(s?.rx_online ?? 0),
      healthy: !!s?.healthy,
      scanned: !!s?.scanned,
    },
    devices,
  };
}

// ── server ops (status / logs / restart / shutdown) ───────────────────────────

export interface ServerStatus {
  version: string;
  source: string;
  uptimeS: number;
  clients: number;
  nodesOnline: number;
  pid: number;
}

export async function fetchServerStatus(url = '/api/v1/server/status'): Promise<ServerStatus> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const j: any = await res.json();
  return {
    version: String(j?.version ?? '?'),
    source: String(j?.source ?? '?'),
    uptimeS: Number(j?.uptime_s ?? 0),
    clients: Number(j?.clients ?? 0),
    nodesOnline: Number(j?.nodes_online ?? 0),
    pid: Number(j?.pid ?? 0),
  };
}

export async function fetchServerLogs(since = 0, base = '/api/v1/server/logs'): Promise<{ next: number; lines: string[] }> {
  const res = await fetch(`${base}?since=${since}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`logs ${res.status}`);
  const j: any = await res.json();
  return { next: Number(j?.next ?? since), lines: Array.isArray(j?.lines) ? j.lines.map(String) : [] };
}

async function postOp(url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { accept: 'application/json' } });
    const j: any = await res.json().catch(() => ({}));
    return { ok: !!j?.ok };
  } catch (e) { return { ok: false, error: String(e) }; }
}
export const restartServer = () => postOp('/api/v1/server/restart');
export const shutdownServer = () => postOp('/api/v1/server/shutdown');

export const MOCK_SERVER_STATUS: ServerStatus = {
  version: '0.3.1', source: 'esp32', uptimeS: 4521, clients: 1, nodesOnline: 3, pid: 162569,
};
export const MOCK_LOGS: string[] = [
  '2026-06-15T07:07:19.763Z  INFO sensing_server: WiFi-DensePose Sensing Server (Rust + Axum + RuVector)',
  '2026-06-15T07:07:19.763Z  INFO sensing_server:   Source:    esp32',
  '2026-06-15T07:07:19.764Z  INFO sensing_server: UDP CSI ingest bound 0.0.0.0:5005',
  '2026-06-15T07:07:20.110Z  INFO sensing_server: node 1 (tx) first frame — illuminator up',
  '2026-06-15T07:07:21.402Z  INFO sensing_server: node 3 (rx) streaming · 137 fps',
  '2026-06-15T07:07:48.991Z  INFO sensing_server: empty-room baseline captured — scoring active',
];

export const MOCK_FLEET: FleetReport = {
  summary: { known: 3, online: 3, txOnline: 1, rxOnline: 2, healthy: true, scanned: true },
  devices: [
    { nodeId: 1, role: 'tx', bucket: 'streaming', provisioned: true, present: false, online: true,
      port: null, chip: null, flashSize: null, ssid: 'KANAYAM', rssiDbm: -48, csiFps: 132, lastSeenS: 0 },
    { nodeId: 2, role: 'rx', bucket: 'streaming', provisioned: true, present: false, online: true,
      port: null, chip: null, flashSize: null, ssid: 'KANAYAM', rssiDbm: -55, csiFps: 130, lastSeenS: 1 },
    { nodeId: 3, role: 'rx', bucket: 'streaming', provisioned: true, present: true, online: true,
      port: '/dev/ttyACM0', chip: 'ESP32-S3', flashSize: '16MB', ssid: 'KANAYAM', rssiDbm: -52, csiFps: 137, lastSeenS: 0 },
  ],
};

export const MOCK_DOCTOR: DoctorReport = {
  ok: true,
  checks: [
    {
      id: 'serial_group',
      label: 'Serial access — write /dev/ttyACM*',
      status: 'ok',
      detail: "you're in a serial group · detected /dev/ttyACM0",
      fix: null,
    },
    {
      id: 'firewall',
      label: 'Firewall — sensing ports open',
      status: 'warn',
      detail: 'ufw active · 5005/udp not allowed — CSI will be dropped',
      fix: 'sudo ufw allow 5005/udp && sudo ufw allow 5353/udp',
    },
    {
      id: 'csi_ingest',
      label: 'CSI ingest — boards streaming',
      status: 'info',
      detail: 'no CSI frames yet — flash + provision a board to begin',
      fix: null,
    },
  ],
};
