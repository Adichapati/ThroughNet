// <tn-events> — the room event log. Events are derived client-side from observed
// state transitions this session (entered / left / still / moving) — honest:
// it logs what the live verdict actually did, not a fabricated history. A
// server-side event stream can replace this later without changing the view.
import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export interface TnEvent {
  t: number;                       // epoch ms
  kind: 'enter' | 'leave' | 'move' | 'still' | 'info';
  text: string;
}

const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

@customElement('tn-events')
export class TnEvents extends LitElement {
  protected createRenderRoot() { return this; }

  @property({ attribute: false }) events: TnEvent[] = [];

  render() {
    return html`<div class="tn-screen"><div class="tn-sheet">
      <h2>events · this session</h2>
      <div class="body">
        ${this.events.length === 0
          ? html`<p class="muted">No transitions yet — entered / left / still / moving will appear here as the room changes.</p>`
          : this.events.map((e) => html`<div class="ev-row">
              <span class="dot ${e.kind === 'enter' ? 'enter' : e.kind === 'move' ? 'move' : 'leave'}"></span>
              <time>${fmt(e.t)}</time><span class="txt">${e.text}</span>
            </div>`)}
      </div>
    </div></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'tn-events': TnEvents; }
}
