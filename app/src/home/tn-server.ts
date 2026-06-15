// <tn-server> — the Server/Ops page (ADR-151 fleet mgmt). The "more control"
// surface: runtime status, a live tail of the server's own log, and
// restart / shutdown. Backed by /api/v1/server/* (localhost-only by bind, or
// bearer-gated). ?mock shows canned status + log so the page works offline.
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  fetchServerStatus, fetchServerLogs, restartServer, shutdownServer,
  MOCK_SERVER_STATUS, MOCK_LOGS, type ServerStatus,
} from '../onboarding/tn-setup';

const isMock = () => new URLSearchParams(location.search).has('mock');
const LOG_CAP = 500;

@customElement('tn-server')
export class TnServer extends LitElement {
  protected createRenderRoot() { return this; }

  @state() private status?: ServerStatus;
  @state() private err = false;
  @state() private lines: string[] = [];
  @state() private confirm: '' | 'restart' | 'shutdown' = '';
  @state() private notice = '';          // transient action feedback
  private since = 0;
  private timer?: ReturnType<typeof setInterval>;

  connectedCallback() {
    super.connectedCallback();
    if (isMock()) { this.status = MOCK_SERVER_STATUS; this.lines = [...MOCK_LOGS]; return; }
    this.poll();
    this.timer = setInterval(() => this.poll(), 2000);
  }
  disconnectedCallback() { super.disconnectedCallback(); clearInterval(this.timer); }

  private async poll() {
    try {
      this.status = await fetchServerStatus();
      const { next, lines } = await fetchServerLogs(this.since);
      if (lines.length) {
        this.since = next;
        this.lines = [...this.lines, ...lines].slice(-LOG_CAP);
        this.scrollLog();
      }
      this.err = false;
    } catch { this.err = true; }
  }

  private scrollLog() {
    // after render, pin the log to the bottom
    this.updateComplete.then(() => {
      const pre = this.querySelector('.sv-log') as HTMLElement | null;
      if (pre) pre.scrollTop = pre.scrollHeight;
    });
  }

  private async doRestart() {
    this.confirm = ''; this.notice = 'restarting — the server will drop briefly, then reconnect…';
    await restartServer();
    // the process re-execs; keep polling — poll() recovers once it's back.
    this.since = 0;
  }

  private async doShutdown() {
    this.confirm = ''; this.notice = 'shutting down — the server is stopping. start it again from your terminal or service manager.';
    await shutdownServer();
    clearInterval(this.timer);
  }

  private fmtUptime(s: number): string {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m`;
  }

  render() {
    const s = this.status;
    return html`<div class="tn-screen"><div class="tn-sheet">
      <h2>server ${s ? `· ${s.source} · up ${this.fmtUptime(s.uptimeS)}` : ''}</h2>
      <div class="body">
        ${this.err && !s ? html`<p class="muted">couldn't reach the server — it may be restarting or stopped.</p>` : ''}
        ${s ? html`
          <div class="sv-stats">
            ${this.stat('version', s.version)}
            ${this.stat('source', s.source)}
            ${this.stat('uptime', this.fmtUptime(s.uptimeS))}
            ${this.stat('nodes online', String(s.nodesOnline))}
            ${this.stat('ws clients', String(s.clients))}
            ${this.stat('pid', String(s.pid))}
          </div>` : ''}

        <div class="sv-loghead"><span class="k">server log</span>${this.err && s ? html`<span class="muted"> · reconnecting…</span>` : ''}</div>
        <pre class="sv-log">${this.lines.length ? this.lines.join('\n') : 'no log lines yet…'}</pre>

        ${this.notice ? html`<div class="dv-msg ok" style="margin-top:12px">${this.notice}</div>` : ''}

        <div class="sv-controls">
          ${this.confirm === 'restart'
            ? html`<span class="sv-ask">restart the server?</span>
                   <button class="dv-btn" @click=${this.doRestart}>yes, restart</button>
                   <button class="dv-btn ghost" @click=${() => (this.confirm = '')}>cancel</button>`
            : this.confirm === 'shutdown'
            ? html`<span class="sv-ask">shut the server down? it won't come back on its own.</span>
                   <button class="dv-btn danger" @click=${this.doShutdown}>yes, shut down</button>
                   <button class="dv-btn ghost" @click=${() => (this.confirm = '')}>cancel</button>`
            : html`<button class="dv-btn" @click=${() => (this.confirm = 'restart')}>restart server</button>
                   <button class="dv-btn danger" @click=${() => (this.confirm = 'shutdown')}>shut down</button>
                   <span style="flex:1"></span>
                   <span class="muted">controls are localhost-only</span>`}
        </div>
      </div>
    </div></div>`;
  }

  private stat(k: string, v: string): TemplateResult {
    return html`<div class="sv-stat"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'tn-server': TnServer; }
}
