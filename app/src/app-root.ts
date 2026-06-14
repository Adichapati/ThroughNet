// <tn-app> — the Phase A app shell. Holds the canonical sensing state, lays out
// the paper-craft chrome (frame, brand, hero state banner, description), the
// live view, and the mock control panel. The panel stands in for
// GET /api/v1/throughnet/status + the /ws/sensing push (ADR-151); swapping it
// for the real transport later won't touch the chrome or the diorama.
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { defaultState, fusedState, type SensingState } from './live/types';
import './live/tn-live-view';
import './onboarding/tn-onboarding';

@customElement('tn-app')
export class TnApp extends LitElement {
  protected createRenderRoot() { return this; }

  @state() private st: SensingState = { ...defaultState };
  // first run shows onboarding; a configured system lands on the live view.
  // (?view=live jumps straight to the home for dev/screenshots.)
  @state() private view: 'onboarding' | 'live' =
    new URLSearchParams(location.search).get('view') === 'live' ? 'live' : 'onboarding';

  private set(patch: Partial<SensingState>) { this.st = { ...this.st, ...patch }; }

  private get isBreathing() { return this.st.present && !this.st.moving && this.st.breathing; }

  render() {
    if (this.view === 'onboarding') {
      return html`<tn-onboarding @finish=${() => { this.view = 'live'; }}></tn-onboarding>`;
    }
    return this.renderLive();
  }

  private renderLive(): TemplateResult {
    const fused = fusedState(this.st);
    const title = this.st.present ? (this.st.moving ? 'Present · Moving' : 'Present · Still') : 'Absent';
    const sub = this.isBreathing ? `${this.st.bpm.toFixed(1)} bpm · breathing`
      : this.st.present ? (this.st.moving ? 'motion detected' : 'still — no breath')
      : 'room empty';

    return html`
      <tn-live-view .state=${this.st}></tn-live-view>

      <div class="tn-frame"><i></i></div>

      <div class="overlay">
        <div class="tn-brand">
          <div class="tn-banner tn-banner--sm">ThroughNet</div>
          <div class="tn-cap tn-cap--tag">Live View</div>
        </div>
        <div class="tn-state">
          <div class="tn-banner tn-banner--lg">${title}</div>
          <div class="tn-cap tn-cap--tag">${sub}</div>
        </div>
        <div class="tn-desc">
          <div class="tn-cap tn-cap--desc">Camera-free presence, motion &amp; breathing — sensed from Wi-Fi alone.</div>
        </div>
      </div>

      ${this.renderPanel(fused)}
    `;
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
