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

// Used in ?mock (serverless demos) so the prepare step still has content.
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
