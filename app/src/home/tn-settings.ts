// <tn-settings> — recalibrate, Wi-Fi, add/re-flash a node, doctor, about.
// Recalibration hits the real endpoints (POST /api/v1/throughnet/baseline/
// start|stop); the rest dispatch a `setup` event (→ re-enter onboarding) or are
// placeholders until the A3 /api/v1/setup/* endpoints land.
import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { ThroughnetStatus } from '../live/tn-client';

@customElement('tn-settings')
export class TnSettings extends LitElement {
  protected createRenderRoot() { return this; }

  @property({ attribute: false }) status: ThroughnetStatus | null = null;
  @state() private note = '';

  private async baseline(action: 'start' | 'stop') {
    try {
      const r = await fetch(`/api/v1/throughnet/baseline/${action}`, { method: 'POST' });
      this.note = r.ok ? (action === 'start' ? 'Calibration started — leave the room empty.' : 'Baseline captured.')
                       : `Server returned ${r.status}.`;
    } catch {
      this.note = 'No sensing server reachable.';
    }
  }

  private setup() { this.dispatchEvent(new CustomEvent('setup', { bubbles: true, composed: true })); }

  render() {
    const cal = this.status?.capturingBaseline
      ? 'capturing…'
      : this.status?.nodes.some((n) => n.baseline) ? 'baseline active' : 'not calibrated';
    return html`<div class="tn-screen"><div class="tn-sheet">
      <h2>settings</h2>
      <div class="body">
        <div class="set-row">
          <div class="lbl">Empty-room baseline<div class="sub">${cal}</div></div>
          <span class="spacer"></span>
          <button @click=${() => this.baseline('start')}>start</button>
          <button class="cta" @click=${() => this.baseline('stop')}>finish</button>
        </div>
        <div class="set-row">
          <div class="lbl">Wi-Fi network<div class="sub">re-provision the fleet onto a new network</div></div>
          <span class="spacer"></span>
          <button @click=${this.setup}>reconfigure</button>
        </div>
        <div class="set-row">
          <div class="lbl">Add or re-flash a node<div class="sub">runs the setup flow</div></div>
          <span class="spacer"></span>
          <button @click=${this.setup}>open setup</button>
        </div>
        <div class="set-row">
          <div class="lbl">About<div class="sub">ThroughNet · Phase A · server-as-shell (ADR-151)</div></div>
        </div>
        ${this.note ? html`<p class="muted" style="margin-top:14px">${this.note}</p>` : ''}
      </div>
    </div></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'tn-settings': TnSettings; }
}
