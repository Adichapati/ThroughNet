// <tn-app> — the Phase A app shell. Routes first-run → onboarding, configured →
// the live diorama home. The home is driven by the real sensing-server
// (TnClient polls /api/v1/throughnet/status); ?mock swaps in a manual control
// panel for demos with no server. Honest states throughout: connecting /
// offline / calibrating / standby (no baseline) / absent / present.
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { defaultState, fusedState, type SensingState } from './live/types';
import { TnClient, toSensingState, type ThroughnetStatus, type ConnState } from './live/tn-client';
import './live/tn-live-view';
import './onboarding/tn-onboarding';

const EMPTY: SensingState = { present: false, moving: false, breathing: false, bpm: 15 };

@customElement('tn-app')
export class TnApp extends LitElement {
  protected createRenderRoot() { return this; }

  private readonly params = new URLSearchParams(location.search);
  // 'mock' = manual panel (demo / no server); 'live' = poll the sensing-server.
  @state() private mode: 'live' | 'mock' = this.params.get('mock') !== null ? 'mock' : 'live';
  @state() private view: 'onboarding' | 'live' = this.params.get('view') === 'live' ? 'live' : 'onboarding';
  @state() private st: SensingState = this.mode === 'mock' ? { ...defaultState } : { ...EMPTY };

  // live transport
  @state() private conn: ConnState = 'connecting';
  @state() private status: ThroughnetStatus | null = null;
  private client?: TnClient;
  private lastBpm = 15;

  updated() {
    if (this.mode === 'live' && this.view === 'live' && !this.client) {
      this.client = new TnClient((status, conn) => {
        this.status = status; this.conn = conn;
        if (status && status.breathingBpm != null) this.lastBpm = status.breathingBpm;
        this.st = toSensingState(status, this.lastBpm);
      });
      this.client.start();
    }
  }

  disconnectedCallback() { super.disconnectedCallback(); this.client?.stop(); }

  private set(patch: Partial<SensingState>) { this.st = { ...this.st, ...patch }; }
  private get isBreathing() { return this.st.present && !this.st.moving && this.st.breathing; }

  render() {
    if (this.view === 'onboarding') {
      return html`<tn-onboarding @finish=${() => { this.view = 'live'; }}></tn-onboarding>`;
    }
    return this.renderLive();
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

  private renderLive(): TemplateResult {
    const b = this.banner();
    return html`
      <tn-live-view .state=${this.st}></tn-live-view>

      <div class="tn-frame"><i></i></div>

      <div class="overlay">
        <div class="tn-brand">
          <div class="tn-banner tn-banner--sm">ThroughNet</div>
          <div class="tn-cap tn-cap--tag">Live View</div>
        </div>
        <div class="tn-state">
          <div class="tn-banner tn-banner--lg">${b.title}</div>
          <div class="tn-cap tn-cap--tag">${b.sub}</div>
        </div>
        <div class="tn-desc">
          <div class="tn-cap tn-cap--desc">Camera-free presence, motion &amp; breathing — sensed from Wi-Fi alone.</div>
        </div>
      </div>

      ${this.mode === 'mock' ? this.renderPanel(fusedState(this.st)) : this.renderConn()}
    `;
  }

  private renderConn(): TemplateResult {
    const n = this.status?.nodes.length ?? 0;
    const label = this.conn === 'live' ? `live · ${n} node${n === 1 ? '' : 's'}`
      : this.conn === 'connecting' ? 'connecting' : 'offline';
    return html`<div class="tn-conn ${this.conn}"><span class="led"></span><b>${label}</b></div>`;
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
