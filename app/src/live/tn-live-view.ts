// <tn-live-view> — owns the canvas + the 3D-anchored label layer + the
// auto-orbit control, and drives the diorama. Renders into light DOM so the
// global chrome CSS applies and the diorama can position the label elements.
import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { createDiorama, type DioramaHandle } from './diorama';
import { defaultState, type SensingState } from './types';

@customElement('tn-live-view')
export class TnLiveView extends LitElement {
  protected createRenderRoot() { return this; }

  @property({ type: Object }) state: SensingState = { ...defaultState };
  @state() private autorotate = true;

  private diorama?: DioramaHandle;

  firstUpdated() {
    const canvas = this.querySelector('canvas') as HTMLCanvasElement;
    const labels = {
      tx: this.querySelector('#tag-tx') as HTMLElement,
      rx2: this.querySelector('#tag-rx2') as HTMLElement,
      rx3: this.querySelector('#tag-rx3') as HTMLElement,
      presence: this.querySelector('#tag-presence') as HTMLElement,
    };
    try {
      this.diorama = createDiorama(canvas, labels);
      this.diorama.setState(this.state);
    } catch (e) {
      const err = this.querySelector('.err') as HTMLElement;
      err.classList.add('show');
      err.textContent = 'WebGL prototype failed to start:\n\n' + ((e as Error)?.message ?? String(e));
      console.error(e);
    }
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has('state')) this.diorama?.setState(this.state);
  }

  disconnectedCallback() { super.disconnectedCallback(); this.diorama?.dispose(); }

  private toggleOrbit() {
    this.autorotate = !this.autorotate;
    this.diorama?.setAutoRotate(this.autorotate);
  }

  render() {
    return html`
      <canvas class="tn-canvas"></canvas>
      <div class="tn-tags">
        <div class="tag" id="tag-tx"><span class="dot"></span>TX · illuminator</div>
        <div class="tag muted" id="tag-rx2"><span class="dot"></span>RX · node 2</div>
        <div class="tag muted" id="tag-rx3"><span class="dot"></span>RX · node 3</div>
        <div class="tag" id="tag-presence"></div>
      </div>
      <button class="viewbtn ${this.autorotate ? '' : 'off'}" @click=${this.toggleOrbit}>
        <span class="ic"></span><span>auto-orbit · ${this.autorotate ? 'on' : 'off'}</span>
      </button>
      <div class="err"></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'tn-live-view': TnLiveView; }
}
