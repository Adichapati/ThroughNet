// <tn-nodes> — per-node health, driven by the live /throughnet/status nodes.
// (RSSI + pps come from /api/v1/nodes later; this shows the verdict-side data:
// presence/motion scores, present/moving/stale, baseline, breathing, last-seen.)
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { NodeStatus, ConnState } from '../live/tn-client';

@customElement('tn-nodes')
export class TnNodes extends LitElement {
  protected createRenderRoot() { return this; }

  @property({ attribute: false }) nodes: NodeStatus[] = [];
  @property() conn: ConnState = 'connecting';

  private seen(ms: number | null): string {
    if (ms == null) return '—';
    return ms < 1500 ? 'now' : `${(ms / 1000).toFixed(1)}s ago`;
  }

  private row(n: NodeStatus): TemplateResult {
    const pill = n.stale ? html`<span class="tn-pill bad">stale</span>`
      : n.baseline ? html`<span class="tn-pill ok">baselined</span>`
      : html`<span class="tn-pill warn">no baseline</span>`;
    return html`<div class="tn-trow">
      <span class="gem ${n.present ? 'present' : ''}"></span>
      <div><div class="v">node ${n.id}</div><div class="k">${n.moving ? 'moving' : n.present ? 'still' : 'quiet'} · seen ${this.seen(n.lastUpdateMs)}</div></div>
      <div><div class="k">scores</div><div class="v">p ${n.presenceScore.toFixed(1)} · m ${n.motionScore.toFixed(1)}</div></div>
      <div><div class="k">breathing</div><div class="v">${n.breathingBpm != null ? n.breathingBpm.toFixed(1) + ' bpm' : '—'}</div></div>
      <div>${pill}</div>
    </div>`;
  }

  render() {
    return html`<div class="tn-screen"><div class="tn-sheet">
      <h2>nodes · ${this.nodes.length} online</h2>
      <div class="body">
        ${this.conn !== 'live'
          ? html`<p class="muted">No sensing server — node health appears once the server is reachable.</p>`
          : this.nodes.length === 0
            ? html`<p class="muted">No nodes have sent frames yet. Power the boards and check the firewall (UDP 5005).</p>`
            : this.nodes.map((n) => this.row(n))}
      </div>
    </div></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'tn-nodes': TnNodes; }
}
