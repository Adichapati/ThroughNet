// <tn-onboarding> — the first-run setup flow. A paper "cover" (the ThroughNet
// title page) tears down a jagged seam and crumples away to reveal a six-step
// wizard: prepare → flash → connect → place → calibrate → done. The step panels
// are mock here (ADR-151 A1); the real localhost /api/v1/setup/* endpoints land
// in A3. Emits a `finish` event when the user enters the app.
import { LitElement, html, svg, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import gsap from 'gsap';

const STEPS = ['prepare', 'flash', 'connect', 'place', 'calibrate', 'done'];

// one jagged seam, shared by both halves so the rip interlocks
const SEAM = [
  [50.0, 0], [51.6, 7], [48.3, 14], [52.4, 21], [49.0, 28], [51.8, 35], [47.6, 42],
  [52.2, 49], [48.8, 56], [51.4, 63], [47.9, 70], [52.6, 77], [49.2, 84], [51.0, 91], [50.0, 100],
];
const SEAM_PTS = SEAM.map(([x, y]) => `${x}% ${y}%`).join(', ');

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
  private tornFlag = false;
  private sway?: gsap.core.Tween;

  private q(sel: string) { return this.querySelector(sel) as HTMLElement | null; }

  firstUpdated() {
    const L = this.q('#cl'), R = this.q('#cr');
    if (L) L.style.clipPath = `polygon(0% 0%, ${SEAM_PTS}, 0% 100%)`;
    if (R) R.style.clipPath = `polygon(100% 0%, ${SEAM_PTS}, 100% 100%)`;

    const jump = new URLSearchParams(location.search).get('onbStep');
    if (jump !== null) {                              // dev: skip the cover to a step
      this.step = Math.max(0, Math.min(5, parseInt(jump, 10) || 0));
      this.coverGone = true;
      this.updateComplete.then(() => { const w = this.q('.wizard'); if (w) gsap.set(w, { opacity: 1, scale: 1 }); });
      return;
    }
    this.sway = gsap.fromTo(this.q('.cover'),
      { rotation: -0.6, x: -5, y: -2 },
      { rotation: 0.6, x: 5, y: 2, duration: 4.6, ease: 'sine.inOut', yoyo: true, repeat: -1, transformOrigin: '50% 6%' });
  }

  private tear() {
    if (this.tornFlag) return; this.tornFlag = true;
    const L = this.q('#cl'), R = this.q('#cr');
    this.sway?.kill();
    const tl = gsap.timeline({ defaults: { ease: 'power3.in' } });
    tl.to(this.q('.cover'), { rotation: 0, x: 0, y: 0, duration: 0.16, ease: 'power2.out' }, 0);
    gsap.to(this.q('.wizard'), { opacity: 1, scale: 1, duration: 1.15, ease: 'power2.out' });
    tl.to(this.q('.begin'), { opacity: 0, y: 10, duration: 0.2, ease: 'power2.in' }, 0)
      .to(this.q('.cover-foot'), { opacity: 0, duration: 0.18 }, 0);
    gsap.set(L, { transformOrigin: '24% 16%' }); gsap.set(R, { transformOrigin: '76% 16%' });
    // 1) seam cracks open
    tl.to(L, { xPercent: -2.6, rotation: -1.6, duration: 0.14, ease: 'power2.out' }, 0.06)
      .to(R, { xPercent: 2.6, rotation: 1.6, duration: 0.14, ease: 'power2.out' }, 0.06);
    // 2) buckle — creases bite in
    tl.to(L, { scale: 0.8, rotation: -12, skewX: 8, duration: 0.2, ease: 'power2.in' }, 0.22)
      .to(R, { scale: 0.8, rotation: 12, skewX: -8, duration: 0.2, ease: 'power2.in' }, 0.24)
      .to(this.q('#cl .crease'), { opacity: 0.6, duration: 0.2 }, 0.22)
      .to(this.q('#cr .crease'), { opacity: 0.6, duration: 0.2 }, 0.24);
    // 3) ball up tight + fling off the top
    tl.to(L, { xPercent: -40, yPercent: -46, rotation: -82, scale: 0.07, skewX: 16, opacity: 0, duration: 0.82 }, 0.4)
      .to(R, { xPercent: 40, yPercent: -42, rotation: 82, scale: 0.07, skewX: -16, opacity: 0, duration: 0.82 }, 0.46)
      .to(this.q('#cl .crease'), { opacity: 1, duration: 0.5 }, 0.4)
      .to(this.q('#cr .crease'), { opacity: 1, duration: 0.5 }, 0.46)
      .add(() => { this.coverGone = true; }, 1.32);
  }

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

  private coverHalf(id: string) {
    return html`<div class="cover-half" id=${id}>
      <div class="cover-inner"><div class="cover-stack">
        ${emblem()}
        <h1 class="title">Throughnet</h1>
        <div class="rule"></div>
        <div class="tagline">camera-free presence · motion · breathing</div>
      </div></div>
      <div class="crease"></div>
    </div>`;
  }

  private renderCover() {
    return html`<div class="cover">
      ${this.coverHalf('cl')}${this.coverHalf('cr')}
      <button class="begin" @click=${this.tear}><span>Begin setup</span><span class="arr"></span></button>
      <div class="cover-foot">tear to begin</div>
    </div>`;
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
