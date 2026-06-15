// <tn-app> — the Phase A app shell. Routes first-run → onboarding, configured →
// the home. The home is diorama-as-home with live data as overlay cards; a slim
// nav switches to Nodes / Events / Settings. Driven by the sensing-server
// (TnClient polls /api/v1/throughnet/status); ?mock swaps in a manual panel.
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { defaultState, fusedState, type SensingState } from './live/types';
import { TnClient, toSensingState, type ThroughnetStatus, type ConnState } from './live/tn-client';
import type { TnEvent } from './home/tn-events';
import './live/tn-live-view';
import './onboarding/tn-onboarding';
import './home/tn-nodes';
import './home/tn-devices';
import './home/tn-server';
import './home/tn-events';
import './home/tn-settings';

const EMPTY: SensingState = { present: false, moving: false, breathing: false, bpm: 15 };
type Tab = 'home' | 'nodes' | 'devices' | 'server' | 'events' | 'settings';

// decorative breathing trace (a few cycles), reused each render
const WAVE = 'M0,13 ' + Array.from({ length: 40 }, (_, i) =>
  `L${((i / 39) * 198).toFixed(0)},${(13 - 9 * Math.sin((i / 39) * Math.PI * 4)).toFixed(1)}`).join(' ');

@customElement('tn-app')
export class TnApp extends LitElement {
  protected createRenderRoot() { return this; }

  private readonly params = new URLSearchParams(location.search);
  @state() private mode: 'live' | 'mock' = this.params.get('mock') !== null ? 'mock' : 'live';
  @state() private view: 'onboarding' | 'live' = this.params.get('view') === 'live' ? 'live' : 'onboarding';
  @state() private tab: Tab = 'home';
  @state() private st: SensingState = this.params.get('mock') !== null ? { ...defaultState } : { ...EMPTY };

  @state() private conn: ConnState = 'connecting';
  @state() private status: ThroughnetStatus | null = null;
  @state() private events: TnEvent[] = [];
  private client?: TnClient;
  private lastBpm = 15;
  private lastFused = '';

  updated() {
    if (this.mode === 'live' && this.view === 'live' && !this.client) {
      this.client = new TnClient((status, conn) => {
        this.status = status; this.conn = conn;
        if (status && status.breathingBpm != null) this.lastBpm = status.breathingBpm;
        this.st = toSensingState(status, this.lastBpm);
        this.logTransition(status, conn);
      });
      this.client.start();
    }
  }

  disconnectedCallback() { super.disconnectedCallback(); this.client?.stop(); }

  // log observed state transitions (session event log — honest, not fabricated)
  private logTransition(status: ThroughnetStatus | null, conn: ConnState) {
    const label = conn !== 'live' ? 'offline'
      : status!.capturingBaseline ? 'calibrating' : status!.state;
    if (label === this.lastFused) return;
    const prev = this.lastFused; this.lastFused = label;
    if (!prev && label !== 'present_still' && label !== 'present_moving') return; // skip initial offline/standby noise
    const ev: TnEvent =
      label === 'present_moving' ? { t: Date.now(), kind: 'move', text: 'motion detected' }
      : label === 'present_still' ? (prev === 'present_moving'
          ? { t: Date.now(), kind: 'still', text: 'became still' }
          : { t: Date.now(), kind: 'enter', text: 'someone entered' })
      : label === 'absent' ? { t: Date.now(), kind: 'leave', text: 'room emptied' }
      : label === 'calibrating' ? { t: Date.now(), kind: 'info', text: 'calibrating baseline' }
      : label === 'offline' ? { t: Date.now(), kind: 'info', text: 'sensor offline' }
      : { t: Date.now(), kind: 'info', text: 'standby — no baseline' };
    this.events = [ev, ...this.events].slice(0, 40);
  }

  private set(patch: Partial<SensingState>) { this.st = { ...this.st, ...patch }; }
  private get isBreathing() { return this.st.present && !this.st.moving && this.st.breathing; }

  render() {
    if (this.view === 'onboarding') {
      return html`<tn-onboarding @finish=${() => { this.view = 'live'; this.tab = 'home'; }}></tn-onboarding>`;
    }
    return this.renderShell();
  }

  private navBtn(tab: Tab, label: string) {
    return html`<button class=${this.tab === tab ? 'on' : ''} @click=${() => { this.tab = tab; }}>${label}</button>`;
  }

  private renderShell(): TemplateResult {
    const b = this.banner();
    return html`
      <tn-live-view .state=${this.st} style=${this.tab === 'home' ? '' : 'display:none'}></tn-live-view>

      <div class="tn-frame"><i></i></div>

      <div class="overlay">
        <div class="tn-brand">
          <div class="tn-banner tn-banner--sm">ThroughNet</div>
          <nav class="tn-nav">
            ${this.navBtn('home', 'live')}${this.navBtn('nodes', 'nodes')}
            ${this.navBtn('devices', 'devices')}${this.navBtn('server', 'server')}
            ${this.navBtn('events', 'events')}${this.navBtn('settings', 'settings')}
          </nav>
        </div>
        ${this.tab === 'home' ? html`
          <div class="tn-state">
            <div class="tn-banner tn-banner--lg">${b.title}</div>
            <div class="tn-cap tn-cap--tag">${b.sub}</div>
          </div>` : ''}
      </div>

      ${this.renderConn()}

      ${this.tab === 'home'
        ? (this.mode === 'mock' ? this.renderPanel(fusedState(this.st)) : this.renderCards())
        : ''}
      ${this.tab === 'nodes' ? html`<tn-nodes .nodes=${this.status?.nodes ?? []} .conn=${this.conn}></tn-nodes>` : ''}
      ${this.tab === 'devices' ? html`<tn-devices></tn-devices>` : ''}
      ${this.tab === 'server' ? html`<tn-server></tn-server>` : ''}
      ${this.tab === 'events' ? html`<tn-events .events=${this.events}></tn-events>` : ''}
      ${this.tab === 'settings'
        ? html`<tn-settings .status=${this.status} @setup=${() => { this.view = 'onboarding'; }}></tn-settings>` : ''}
    `;
  }

  // hero state banner — honest across every connection / sensing state
  private banner(): { title: string; sub: string } {
    if (this.mode === 'mock') {
      return {
        title: this.st.present ? (this.st.moving ? 'Present · Moving' : 'Present · Still') : 'Absent',
        sub: this.isBreathing ? `${this.st.bpm.toFixed(1)} bpm · breathing`
          : this.st.present ? (this.st.moving ? 'motion detected' : 'still — no breath') : 'room empty',
      };
    }
    if (this.conn === 'connecting') return { title: 'Connecting…', sub: 'reaching the sensor' };
    if (this.conn === 'offline') return { title: 'Sensor Offline', sub: 'no sensing server on :8080' };
    const s = this.status!;
    if (s.capturingBaseline) return { title: 'Calibrating…', sub: 'capturing empty-room baseline' };
    switch (s.state) {
      case 'present_moving': return { title: 'Present · Moving', sub: 'motion detected' };
      case 'present_still': return {
        title: 'Present · Still',
        sub: s.breathingBpm != null ? `${s.breathingBpm.toFixed(1)} bpm · breathing` : 'still — no breath',
      };
      case 'absent': return { title: 'Absent', sub: 'room empty' };
      default: return { title: 'Standby', sub: 'awaiting baseline — calibrate to begin' };
    }
  }

  private renderConn(): TemplateResult {
    const n = this.status?.nodes.length ?? 0;
    const label = this.conn === 'live' ? `live · ${n} node${n === 1 ? '' : 's'}`
      : this.conn === 'connecting' ? 'connecting' : 'offline';
    return html`<div class="tn-conn ${this.conn}"><span class="led"></span><b>${label}</b></div>`;
  }

  // home overlay cards — breathing + node-health, over the diorama
  private renderCards(): TemplateResult {
    const s = this.status;
    const breathing = !!s && s.state === 'present_still' && s.breathingBpm != null;
    return html`
      <div class="tn-card tn-card--breath">
        <h4>breathing</h4>
        ${breathing ? html`
          <div class="breath-read"><span class="bpm">${s!.breathingBpm!.toFixed(1)}</span><span class="u">bpm</span></div>
          <svg class="breath-wave" viewBox="0 0 198 26" preserveAspectRatio="none"><path d=${WAVE}></path></svg>
          <div class="breath-conf">confidence ${s!.breathingConfidence != null ? s!.breathingConfidence.toFixed(1) : '—'}</div>`
        : html`
          <div class="breath-read"><span class="bpm">—</span></div>
          <div class="breath-conf">${this.conn !== 'live' ? 'offline' : 'no breathing signal'}</div>`}
      </div>
      <div class="tn-card tn-card--nodes">
        <h4>nodes${s ? ` · ${s.nodes.length}` : ''}</h4>
        ${(s?.nodes ?? []).slice(0, 4).map((n) => html`<div class="nd-row">
          <span class="gem ${n.present ? 'present' : ''} ${n.stale ? 'stale' : ''}"></span>
          node ${n.id}<span class="st">${n.rssiDbm != null
            ? `${n.rssiDbm.toFixed(0)}dBm${n.csiFps != null ? ' · ' + n.csiFps.toFixed(0) + 'Hz' : ''}`
            : (n.stale ? 'stale' : n.moving ? 'moving' : n.present ? 'still' : 'quiet')}</span>
        </div>`)}
        ${(!s || s.nodes.length === 0) ? html`<div class="nd-row" style="color:var(--ink-soft)">no nodes online</div>` : ''}
      </div>`;
  }

  private seg(active: boolean, label: string, on: () => void): TemplateResult {
    return html`<button class=${active ? 'on' : ''} @click=${on}>${label}</button>`;
  }

  private renderPanel(fused: string): TemplateResult {
    const bpmStr = this.isBreathing ? this.st.bpm.toFixed(1) : 'null';
    const confStr = this.isBreathing ? '4.5' : 'null';
    return html`
      <div class="panel">
        <h2>state driver · mock /throughnet/status</h2>
        <div class="panel-body">
          <div class="row">
            <label>presence</label>
            <div class="seg">
              ${this.seg(this.st.present, 'present', () => this.set({ present: true }))}
              ${this.seg(!this.st.present, 'absent', () => this.set({ present: false }))}
            </div>
          </div>
          <div class="row">
            <label>motion</label>
            <div class="seg">
              ${this.seg(!this.st.moving, 'still', () => this.set({ moving: false }))}
              ${this.seg(this.st.moving, 'moving', () => this.set({ moving: true }))}
            </div>
          </div>
          <div class="row">
            <label>breathing</label>
            <div class="seg">
              ${this.seg(this.st.breathing, 'on', () => this.set({ breathing: true }))}
              ${this.seg(!this.st.breathing, 'off', () => this.set({ breathing: false }))}
            </div>
          </div>
          <div class="row">
            <label>bpm</label>
            <div style="display:flex;align-items:center;gap:9px;">
              <input type="range" min="6" max="30" step="0.5" .value=${String(this.st.bpm)}
                @input=${(e: Event) => this.set({ bpm: +(e.target as HTMLInputElement).value })}>
              <span class="bpmval">${this.st.bpm.toFixed(1)}</span>
            </div>
          </div>
          <div class="json">
            <div><span class="k">state</span> "${fused}"</div>
            <div><span class="k">breathing_bpm</span> ${bpmStr}</div>
            <div><span class="k">breathing_conf</span> ${confStr}</div>
            <div><span class="k">nodes</span> 2 · 3 (rx)</div>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'tn-app': TnApp; }
}
