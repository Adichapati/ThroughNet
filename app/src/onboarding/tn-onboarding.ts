// <tn-onboarding> — the first-run setup flow. The cover (the ThroughNet title
// page) is a draggable WebGL paper tear (tn-tear): drag down to rip it open,
// revealing a six-step wizard behind it — prepare → flash → connect → place →
// calibrate → done. The step panels are mock here (ADR-151 A1); the real
// localhost /api/v1/setup/* endpoints land in A3. Emits `finish` on entry.
import { LitElement, html, svg, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { createTear, type TearHandle } from './tn-tear';

const STEPS = ['prepare', 'flash', 'connect', 'place', 'calibrate', 'done'];

// the pull-down hand hint (user-provided)
const HAND = svg`<svg viewBox="0 0 175 200"><path d="M173.272 82.5157C161.668 70.5528 146.803 62.2655 130.526 58.6846C118.575 55.6811 106.321 54.0528 94.0011 53.8313V20.8535C93.8062 15.2638 91.4057 9.97869 87.3246 6.15411C83.2435 2.32953 77.8139 0.276704 72.2233 0.444604C66.6327 0.276704 61.2031 2.32953 57.122 6.15411C53.0409 9.97869 50.6404 15.2638 50.4455 20.8535V83.0757L40.49 73.2446C36.1045 68.9428 30.2064 66.5329 24.0633 66.5329C17.9201 66.5329 12.0221 68.9428 7.63662 73.2446C5.43939 75.3674 3.69046 77.9095 2.49342 80.7204C1.29638 83.5313 0.675563 86.5539 0.667733 89.609C0.553645 95.5326 2.79095 101.26 6.88996 105.538L35.8855 139.885C37.2844 148.66 40.3015 157.1 44.7833 164.773C48.0577 170.674 52.2595 176.011 57.2277 180.578V192.525C57.2082 194.228 57.8424 195.874 58.9999 197.124C60.1573 198.374 61.75 199.133 63.45 199.245H150.001C151.701 199.133 153.294 198.374 154.451 197.124C155.609 195.874 156.243 194.228 156.223 192.525V175.725C168.45 161.166 175.07 142.717 174.89 123.707V86.3735C174.812 84.9394 174.24 83.5764 173.272 82.5157ZM162.445 124.018C162.843 140.561 157.077 156.662 146.268 169.191C144.894 170.31 144.003 171.914 143.779 173.671V187.111H69.9833V177.902C69.9848 176.883 69.736 175.879 69.2586 174.979C68.7812 174.078 68.0899 173.309 67.2455 172.738C62.5824 168.915 58.732 164.197 55.9211 158.862C51.9575 152.15 49.416 144.695 48.4544 136.96C48.3876 135.614 47.8854 134.325 47.0233 133.289L16.41 97.0757C15.4129 96.0917 14.6212 94.9195 14.0808 93.627C13.5405 92.3346 13.2622 90.9477 13.2622 89.5468C13.2622 88.146 13.5405 86.7591 14.0808 85.4666C14.6212 84.1742 15.4129 83.0019 16.41 82.0179C18.4587 80.0002 21.2189 78.8691 24.0944 78.8691C26.9699 78.8691 29.7301 80.0002 31.7788 82.0179L50.4455 100.685V120.222L62.89 114V20.8535C63.1113 18.5757 64.2079 16.4726 65.9487 14.987C67.6896 13.5015 69.939 12.7494 72.2233 12.889C74.5076 12.7494 76.7569 13.5015 78.4978 14.987C80.2387 16.4726 81.3353 18.5757 81.5566 20.8535V94.2757L94.0011 96.9513V66.3379C99.2229 66.4409 104.436 66.8148 109.619 67.4579V100L119.574 102.178V68.889C122.126 69.3868 124.739 69.9468 127.414 70.6313C130.64 71.4754 133.818 72.4932 136.934 73.6802V105.725L146.89 107.902V78.2224C152.546 81.0774 157.781 84.6997 162.445 88.9868V124.018Z"/></svg>`;

const emblem = (cls = 'emblem') => svg`
  <svg class=${cls} viewBox="0 0 74 64">
    <path d="M37 12 L12 52 L62 52 Z"/>
    <circle class="node tx" cx="37" cy="12" r="5.4"/>
    <circle class="node rx" cx="12" cy="52" r="5.4"/>
    <circle class="node rx" cx="62" cy="52" r="5.4"/>
    <rect class="pres" x="32.5" y="33" width="9" height="9" transform="rotate(45 37 37.5)"/>
  </svg>`;

@customElement('tn-onboarding')
export class TnOnboarding extends LitElement {
  protected createRenderRoot() { return this; }

  @state() private step = 0;
  @state() private coverGone = false;
  @state() private handVisible = false;
  private tear?: TearHandle;
  private handTimer?: ReturnType<typeof setTimeout>;

  private q(sel: string) { return this.querySelector(sel) as HTMLElement | null; }

  firstUpdated() {
    const jump = new URLSearchParams(location.search).get('onbStep');
    if (jump !== null) {                              // dev: skip the cover to a step
      this.step = Math.max(0, Math.min(5, parseInt(jump, 10) || 0));
      this.coverGone = true;
      return;
    }
    const canvas = this.q('.tear-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    createTear(canvas, {
      onFirstInteract: () => this.hideHand(),
      onComplete: () => { this.coverGone = true; this.tear = undefined; },
    }).then((h) => { this.tear = h; }).catch((e) => { console.error(e); this.coverGone = true; });
    this.handTimer = setTimeout(() => { if (!this.coverGone) this.handVisible = true; }, 3500);
  }

  disconnectedCallback() { super.disconnectedCallback(); this.tear?.dispose(); clearTimeout(this.handTimer); }

  private hideHand() { this.handVisible = false; clearTimeout(this.handTimer); }
  private beginClick() { this.hideHand(); this.tear?.begin(); }

  private next() { if (this.step < 5) this.step += 1; else this.finish(); }
  private back() { if (this.step > 0) this.step -= 1; }
  private finish() { this.dispatchEvent(new CustomEvent('finish', { bubbles: true, composed: true })); }

  render() {
    return html`
      <div class="tn-frame"><i></i></div>
      <section class="wizard">
        <div class="wiz-col">
          ${this.renderRail()}
          ${this.renderStep()}
        </div>
      </section>
      ${this.coverGone ? '' : this.renderCover()}
    `;
  }

  private renderRail() {
    return html`<div class="wiz-rail">${STEPS.map((s, i) => html`
      ${i > 0 ? html`<span class="seg"></span>` : ''}
      <span class="pip ${i === this.step ? 'on' : i < this.step ? 'done' : ''}"></span>${i === this.step ? html`<b>${s}</b>` : s}
    `)}</div>`;
  }

  private renderCover() {
    return html`
      <canvas class="tear-canvas"></canvas>
      <button class="begin" @click=${this.beginClick}><span>Begin setup</span><span class="arr"></span></button>
      <div class="cover-foot">drag down to tear — or click</div>
      ${this.handVisible ? html`<div class="hand">${HAND}</div>` : ''}
    `;
  }

  private header(label: string) {
    return html`<h2>set up · step ${this.step + 1} of 6 · ${label}</h2>`;
  }

  private nav(ctaLabel: string, ctaDisabled = false) {
    return html`<div class="actions">
      ${this.step > 0 ? html`<button class="btn ghost" @click=${this.back}>back</button>` : ''}
      <span class="spacer"></span>
      <button class="btn cta" ?disabled=${ctaDisabled} @click=${this.next}>${ctaLabel} ▸</button>
    </div>`;
  }

  private renderStep(): TemplateResult {
    switch (this.step) {
      case 0: return this.stepPrepare();
      case 1: return this.stepFlash();
      case 2: return this.stepConnect();
      case 3: return this.stepPlace();
      case 4: return this.stepCalibrate();
      default: return this.stepDone();
    }
  }

  private stepPrepare() {
    return html`<div class="card">${this.header('prepare')}
      <div class="card-body wide">
        <p>ThroughNet needs a few things from this machine before it can reach your boards. Here's the preflight.</p>
        <div class="check ok"><span class="mk">✓</span><div><div class="lbl">Serial access — <code class="cmd">/dev/ttyACM*</code> writable</div><div class="sub">you're in the <b>uucp</b> group</div></div></div>
        <div class="check warn"><span class="mk">!</span><div><div class="lbl">Firewall — open the sensing ports</div><div class="sub">run <code class="cmd">sudo ufw allow 5005/udp &amp;&amp; sudo ufw allow 5353/udp</code> · then re-check</div></div></div>
        <div class="check ok"><span class="mk">✓</span><div><div class="lbl">Ports free — 8080 (ui) · 5005 (csi)</div><div class="sub">nothing else is listening</div></div></div>
        ${this.nav('continue anyway')}
      </div></div>`;
  }

  private stepFlash() {
    const board = svg`<svg viewBox="0 0 80 80" fill="none">
      <rect x="22" y="14" width="36" height="52" rx="3" stroke="#2B2A26" stroke-width="1.6" fill="#FBF8F2"/>
      <rect x="29" y="22" width="22" height="16" rx="1.5" fill="#AFC0D2" stroke="#2B2A26" stroke-width="1.2"/>
      <line x1="34" y1="46" x2="46" y2="46" stroke="#2B2A26" stroke-width="1.2"/>
      <line x1="34" y1="52" x2="46" y2="52" stroke="#2B2A26" stroke-width="1.2"/>
      <path d="M40 66 L40 74 M33 74 L47 74" stroke="#2B2A26" stroke-width="1.6"/></svg>`;
    return html`<div class="card">${this.header('flash')}
      <div class="card-body">
        <div class="vignette">${board}</div>
        <div>
          <h3>Add your first node</h3>
          <p>Plug an ESP32-S3 into this computer with a USB cable. ThroughNet flashes the sensing firmware — the first board becomes your TX illuminator.</p>
          <div style="margin-bottom:16px"><code class="cmd">detected · /dev/ttyACM0 · ESP32-S3 (8 MB)</code></div>
          ${this.nav('flash firmware')}
        </div>
      </div></div>`;
  }

  private stepConnect() {
    return html`<div class="card">${this.header('connect')}
      <div class="card-body wide">
        <h3>Connect it to Wi-Fi</h3>
        <p>Enter your network once — every node reuses it. ThroughNet assigns roles automatically: the first board is the TX illuminator, the rest are RX, locked to the TX.</p>
        <div class="field"><label>wi-fi network</label><select><option>home-2.4ghz</option><option>workshop-iot</option></select></div>
        <div class="field"><label>password</label><input type="password" value="············"></div>
        <div class="fleet">
          <div class="nd"><span class="gem tx"></span> node 2 <span class="role">tx · illuminator</span> <span class="spacer"></span><code class="cmd">streaming ✓</code></div>
          <div class="nd"><span class="gem rx"></span> node 3 <span class="role">rx</span> <span class="spacer"></span><code class="cmd">streaming ✓</code></div>
          <div class="nd" style="opacity:.5"><span class="gem rx"></span> add a third node <span class="role">rx</span> <span class="spacer"></span><code class="cmd">need 1 tx + 2 rx</code></div>
        </div>
        ${this.nav('connect')}
      </div></div>`;
  }

  private stepPlace() {
    const diagram = svg`<svg viewBox="0 0 460 150" width="100%" fill="none">
      <rect x="1" y="1" width="458" height="148" stroke="#56524A" stroke-dasharray="3 4"/>
      <line x1="230" y1="32" x2="120" y2="118" stroke="#2B2A26" stroke-width="1.2"/>
      <line x1="230" y1="32" x2="340" y2="118" stroke="#2B2A26" stroke-width="1.2"/>
      <rect x="223" y="25" width="14" height="14" transform="rotate(45 230 32)" fill="#D8C09A" stroke="#2B2A26" stroke-width="1.4"/>
      <rect x="113" y="111" width="14" height="14" transform="rotate(45 120 118)" fill="#93A7BE" stroke="#2B2A26" stroke-width="1.4"/>
      <rect x="333" y="111" width="14" height="14" transform="rotate(45 340 118)" fill="#93A7BE" stroke="#2B2A26" stroke-width="1.4"/>
      <circle cx="230" cy="92" r="9" fill="#D89A85" stroke="#2B2A26" stroke-width="1.4"/>
      <text x="230" y="20" fill="#2B2A26" font-family="monospace" font-size="9" text-anchor="middle">TX</text>
      <text x="120" y="138" fill="#2B2A26" font-family="monospace" font-size="9" text-anchor="middle">RX2</text>
      <text x="340" y="138" fill="#2B2A26" font-family="monospace" font-size="9" text-anchor="middle">RX3</text></svg>`;
    return html`<div class="card">${this.header('place')}
      <div class="card-body wide">
        <h3>Place your nodes</h3>
        <div class="diagram">${diagram}</div>
        <p>Put the TX on one side of the room and the RX boards across from it, so people cross the link lines. Nudge the boards until both links read strong.</p>
        <div class="link"><span class="nm">tx → rx2</span><div class="bar"><i style="width:74%"></i></div><span class="db">−52 dBm</span></div>
        <div class="link"><span class="nm">tx → rx3</span><div class="bar"><i style="width:67%"></i></div><span class="db">−55 dBm</span></div>
        ${this.nav('looks good')}
      </div></div>`;
  }

  private stepCalibrate() {
    const clock = svg`<svg viewBox="0 0 80 80" fill="none">
      <circle cx="40" cy="42" r="24" stroke="#2B2A26" stroke-width="1.6" fill="#FBF8F2"/>
      <path d="M40 42 L40 28 M40 42 L52 48" stroke="#2B2A26" stroke-width="1.6"/>
      <path d="M40 12 L40 18 M22 14 L46 14" stroke="#2B2A26" stroke-width="1.6"/></svg>`;
    return html`<div class="card">${this.header('calibrate')}
      <div class="card-body">
        <div class="vignette">${clock}</div>
        <div>
          <h3>Calibrate the empty room</h3>
          <p>Step out and leave the room empty for a moment. ThroughNet captures the empty-room baseline — that's what switches sensing on and keeps false alarms at zero.</p>
          <div class="progress"><i style="width:62%"></i></div>
          ${this.nav('start calibration')}
        </div>
      </div></div>`;
  }

  private stepDone() {
    return html`<div class="card">${this.header('done')}
      <div class="card-body wide" style="text-align:center; justify-items:center;">
        ${emblem('big-emblem')}
        <h3 style="margin-top:14px">You're all set</h3>
        <p>3 nodes online · empty-room baseline captured. ThroughNet is sensing your room — presence, motion, and breathing, no camera.</p>
        <div class="actions" style="justify-content:center">
          <button class="btn cta" @click=${this.finish}>enter throughnet ▸</button>
        </div>
      </div></div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'tn-onboarding': TnOnboarding; }
}
