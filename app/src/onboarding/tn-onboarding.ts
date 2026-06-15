// <tn-onboarding> — the first-run setup flow. The cover (the ThroughNet title
// page) is a draggable WebGL paper tear (tn-tear): drag down to rip it open,
// revealing a six-step wizard behind it — prepare → flash → connect → place →
// calibrate → done. The step panels are mock here (ADR-151 A1); the real
// localhost /api/v1/setup/* endpoints land in A3. Emits `finish` on entry.
import { LitElement, html, svg, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { createTear, type TearHandle } from './tn-tear';
import {
  fetchDoctor, MOCK_DOCTOR, flashBoard, provisionBoard,
  fetchFleet, MOCK_FLEET,
  type DoctorCheck, type DoctorReport, type ProvisionResult,
  type FleetReport, type FleetDevice,
} from './tn-setup';

const isMock = () => new URLSearchParams(location.search).has('mock');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  // ADR-151 A3: the prepare step's host preflight (real /api/v1/setup/doctor).
  @state() private doctor?: DoctorReport;
  @state() private doctorLoading = false;
  @state() private doctorError = false;
  // A3 flash step (real /api/v1/setup/fleet?scan + /flash).
  @state() private scanning = false;
  @state() private flashing = false;
  @state() private flashed = false;
  @state() private flashError?: string;
  private port?: string;
  // Fleet reconciler (state ∪ live) — drives "already set up, skip it" so we
  // never tell the user to re-flash a working board, and guards the TX.
  @state() private fleet?: FleetReport;
  @state() private addingNode = false;    // user chose to add a node to a healthy fleet
  @state() private reflashConfirm = false; // user opted into re-flashing a known board
  // A3 connect step (real /api/v1/setup/provision).
  @state() private ssid = '';
  @state() private password = '';
  @state() private provisioning = false;
  @state() private provisioned?: ProvisionResult;
  @state() private provError?: string;
  private tear?: TearHandle;
  private handTimer?: ReturnType<typeof setTimeout>;

  private q(sel: string) { return this.querySelector(sel) as HTMLElement | null; }

  firstUpdated() {
    this.runDoctor();                                 // preflight ready by the time prepare shows
    this.loadFleet();                                 // know if the fleet's already up before the tear opens
    const jump = new URLSearchParams(location.search).get('onbStep');
    if (jump !== null) {                              // dev: skip the cover to a step
      this.step = Math.max(0, Math.min(5, parseInt(jump, 10) || 0));
      this.coverGone = true;
      this.onEnterStep();
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

  private next() {
    if (this.step < 5) { this.step += 1; this.onEnterStep(); }
    else this.finish();
  }
  private back() { if (this.step > 0) { this.step -= 1; this.onEnterStep(); } }
  private finish() { this.dispatchEvent(new CustomEvent('finish', { bubbles: true, composed: true })); }

  // Kick off the work a step needs when it first becomes visible.
  private onEnterStep() {
    if (this.step === 1 && !this.scanning) this.doScan();
  }

  // The flash step's scan now goes through the reconciler (scan + state + live)
  // so we learn whether the plugged-in board is already set up — not just that
  // a chip is present.
  private async doScan() {
    this.scanning = true; this.flashError = undefined; this.reflashConfirm = false;
    try {
      if (isMock()) {
        await sleep(500); this.fleet = MOCK_FLEET;
      } else {
        this.fleet = await fetchFleet(true);   // ?scan=true: probe USB + reconcile
      }
      this.port = this.presentDevice()?.port ?? undefined;
    } catch { this.fleet = undefined; this.port = undefined; }
    finally { this.scanning = false; }
  }

  // Reconcile the whole fleet (fast: state ∪ live, no USB probe). Failure leaves
  // `fleet` undefined so onboarding falls back to the plain first-run flow.
  private async loadFleet(scan = false) {
    if (isMock()) { this.fleet = MOCK_FLEET; return; }
    try { this.fleet = await fetchFleet(scan); } catch { /* fall back to wizard */ }
  }

  // The board plugged in right now (the one any flash/provision acts on).
  private presentDevice(): FleetDevice | undefined {
    return this.fleet?.devices.find((d) => d.present);
  }

  // Skip onboarding entirely when the mesh is already up (and the user hasn't
  // explicitly chosen to add another node).
  private get fleetHealthy(): boolean {
    return !!this.fleet?.summary.healthy && !this.addingNode;
  }

  private addNode() { this.addingNode = true; this.step = 1; this.onEnterStep(); }

  private async doFlash() {
    if (!this.port) return;
    this.flashing = true; this.flashError = undefined; this.flashed = false;
    try {
      const r = isMock() ? (await sleep(1200), { success: true }) : await flashBoard(this.port);
      if (r.success) this.flashed = true;
      else this.flashError = r.error || 'flash failed';
    } catch (e) { this.flashError = String(e); }
    finally { this.flashing = false; }
  }

  private async doProvision() {
    if (!this.port) { this.provError = 'no board — flash one first'; return; }
    this.provisioning = true; this.provError = undefined; this.provisioned = undefined;
    try {
      const r = isMock()
        ? (await sleep(1200), { success: true, role: 'rx', nodeId: 3 })
        : await provisionBoard({ port: this.port, ssid: this.ssid, password: this.password });
      if (r.success) this.provisioned = r;
      else this.provError = r.error || 'provision failed';
    } catch (e) { this.provError = String(e); }
    finally { this.provisioning = false; }
  }

  // Run (or re-run) the host preflight. ?mock keeps it serverless for demos.
  private async runDoctor() {
    if (new URLSearchParams(location.search).has('mock')) {
      this.doctor = MOCK_DOCTOR; this.doctorError = false; this.doctorLoading = false; return;
    }
    this.doctorLoading = true; this.doctorError = false;
    try { this.doctor = await fetchDoctor(); }
    catch { this.doctorError = true; }
    finally { this.doctorLoading = false; }
  }

  render() {
    // Already-set-up short-circuit: a healthy fleet skips the whole wizard (and
    // its step rail) so re-opening setup never demands a pointless re-flash.
    const shortCircuit = this.coverGone && this.fleetHealthy;
    return html`
      <div class="tn-frame"><i></i></div>
      <section class="wizard">
        <div class="wiz-col">
          ${shortCircuit ? '' : this.renderRail()}
          ${shortCircuit ? this.renderAlreadySetUp() : this.renderStep()}
        </div>
      </section>
      ${this.coverGone ? '' : this.renderCover()}
    `;
  }

  private renderFleetRow(d: FleetDevice) {
    const tx = d.role === 'tx';
    const status = d.online ? `${Math.round(d.csiFps ?? 0)} fps` : 'offline';
    return html`<div class="nd">
      <span class="gem ${tx ? 'tx' : 'rx'}"></span> node ${d.nodeId ?? '?'}
      <span class="role">${d.role ?? 'rx'}${tx ? ' · illuminator' : ''}</span>
      <span class="spacer"></span>
      <code class="cmd ${d.online ? '' : 'off'}">${status}</code>
    </div>`;
  }

  private renderAlreadySetUp() {
    const s = this.fleet!.summary;
    const known = this.fleet!.devices.filter((d) => d.provisioned);
    return html`<div class="card">
      <h2>set up · ready</h2>
      <div class="card-body wide" style="text-align:center; justify-items:center;">
        ${emblem('big-emblem')}
        <h3 style="margin-top:14px">Your fleet's already set up</h3>
        <p>${s.txOnline} illuminator · ${s.rxOnline} receiver${s.rxOnline === 1 ? '' : 's'} online —
           ThroughNet is sensing. No need to flash anything again.</p>
        ${known.length ? html`<div class="fleet" style="width:100%">${known.map((d) => this.renderFleetRow(d))}</div>` : ''}
        <div class="actions" style="justify-content:center">
          <button class="btn ghost" @click=${this.addNode}>add another node</button>
          <button class="btn cta" @click=${this.finish}>enter throughnet ▸</button>
        </div>
      </div></div>`;
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
    const checks = this.doctor?.checks ?? [];
    const hasWarn = checks.some((c) => c.status === 'warn' || c.status === 'fail');
    const cta = this.doctorError || hasWarn ? 'continue anyway' : 'continue';
    return html`<div class="card">${this.header('prepare')}
      <div class="card-body wide">
        <p>ThroughNet needs a few things from this machine before it can reach your boards. Here's the preflight.</p>
        ${this.renderDoctor()}
        <div class="actions">
          <button class="btn ghost" @click=${this.runDoctor} ?disabled=${this.doctorLoading}>${this.doctorLoading ? 'checking…' : 're-check'}</button>
          <span class="spacer"></span>
          <button class="btn cta" @click=${this.next}>${cta} ▸</button>
        </div>
      </div></div>`;
  }

  private renderDoctor() {
    if (this.doctorLoading && !this.doctor) {
      return html`<div class="check info"><span class="mk">·</span><div><div class="lbl">running preflight…</div></div></div>`;
    }
    if (this.doctorError) {
      return html`<div class="check warn"><span class="mk">!</span><div>
        <div class="lbl">couldn't reach the setup service</div>
        <div class="sub">make sure ThroughNet is running, then <b>re-check</b></div></div></div>`;
    }
    return (this.doctor?.checks ?? []).map((c) => this.renderCheck(c));
  }

  private renderCheck(c: DoctorCheck) {
    const mark = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : c.status === 'fail' ? '✕' : '·';
    return html`<div class="check ${c.status}"><span class="mk">${mark}</span><div>
      <div class="lbl">${c.label}</div>
      <div class="sub">${c.detail}${c.fix ? html` · <code class="cmd">${c.fix}</code>` : ''}</div>
    </div></div>`;
  }

  private stepFlash() {
    const board = svg`<svg viewBox="0 0 80 80" fill="none">
      <rect x="22" y="14" width="36" height="52" rx="3" stroke="#2B2A26" stroke-width="1.6" fill="#FBF8F2"/>
      <rect x="29" y="22" width="22" height="16" rx="1.5" fill="#AFC0D2" stroke="#2B2A26" stroke-width="1.2"/>
      <line x1="34" y1="46" x2="46" y2="46" stroke="#2B2A26" stroke-width="1.2"/>
      <line x1="34" y1="52" x2="46" y2="52" stroke="#2B2A26" stroke-width="1.2"/>
      <path d="M40 66 L40 74 M33 74 L47 74" stroke="#2B2A26" stroke-width="1.6"/></svg>`;
    const dev = this.presentDevice();
    // "known" = the plugged-in board already has a provision state / is streaming.
    // We must NOT silently re-flash it — that's exactly what broke the mesh.
    const known = !!dev && dev.bucket !== 'unprovisioned';
    const isTx = dev?.role === 'tx';
    const heading = this.addingNode ? 'Add another node' : 'Add your first node';

    let status;
    if (this.scanning) {
      status = html`<code class="cmd">scanning for boards…</code>`;
    } else if (dev) {
      const id = dev.nodeId != null ? ` · node ${dev.nodeId} (${dev.role ?? 'rx'})` : '';
      status = html`<code class="cmd">detected · ${dev.port ?? '?'} · ${dev.chip ?? 'unknown'}${dev.flashSize ? ` (${dev.flashSize})` : ''}${id}</code>`;
    } else {
      status = html`<code class="cmd">no board found — plug an ESP32-S3 in via USB</code>`;
    }

    // TX guard: reflashing/rebooting the illuminator drops every RX at once.
    const txWarn = isTx ? html`<div class="check warn" style="margin-bottom:12px"><span class="mk">!</span><div>
      <div class="lbl">this board is your TX illuminator</div>
      <div class="sub">Re-flashing it reboots the beacon — every receiver goes dark for ~20 s while it comes back. Only do this if you mean to; flash your RX nodes separately.</div></div></div>` : '';

    // Already-set-up board: offer continue, with re-flash as a deliberate, guarded
    // secondary action (the user's missing "I really do want to re-flash" path).
    if (known && !this.flashed && !this.reflashConfirm) {
      return html`<div class="card">${this.header('flash')}
        <div class="card-body">
          <div class="vignette">${board}</div>
          <div>
            <h3>${heading}</h3>
            <div class="check ok" style="margin:2px 0 10px"><span class="mk">✓</span><div>
              <div class="lbl">already set up — node ${dev!.nodeId ?? '?'} · ${dev!.role ?? 'rx'}${isTx ? ' · illuminator' : ''}</div>
              <div class="sub">${dev!.online ? 'streaming now' : 'provisioned'} on ${dev!.ssid ?? 'your network'} — no flash needed.</div></div></div>
            <div style="margin-bottom:12px">${status}</div>
            ${txWarn}
            <div class="actions">
              <button class="btn ghost" @click=${this.back}>back</button>
              <button class="btn ghost" @click=${this.doScan} ?disabled=${this.scanning}>rescan</button>
              <button class="btn ghost" @click=${() => { this.reflashConfirm = true; }}>re-flash anyway</button>
              <span class="spacer"></span>
              <button class="btn cta" @click=${this.next}>continue ▸</button>
            </div>
          </div>
        </div></div>`;
    }

    const cta = this.flashing ? 'flashing…' : this.flashed ? 'flashed ✓' : 'flash firmware';
    const blurb = this.addingNode
      ? html`Plug the new ESP32-S3 in via USB. ThroughNet flashes the sensing firmware and adds it as an RX, locked to your existing TX.`
      : html`Plug an ESP32-S3 into this computer with a USB cable. ThroughNet flashes the sensing firmware — the first board becomes your TX illuminator.`;
    return html`<div class="card">${this.header('flash')}
      <div class="card-body">
        <div class="vignette">${board}</div>
        <div>
          <h3>${heading}</h3>
          <p>${blurb}</p>
          <div style="margin-bottom:14px">${status}</div>
          ${this.reflashConfirm ? txWarn : ''}
          ${this.flashError ? html`<div class="check fail" style="margin-bottom:12px"><span class="mk">✕</span><div><div class="lbl">flash failed</div><div class="sub">${this.flashError}</div></div></div>` : ''}
          <div class="actions">
            <button class="btn ghost" @click=${this.back}>back</button>
            <button class="btn ghost" @click=${this.doScan} ?disabled=${this.scanning || this.flashing}>rescan</button>
            <span class="spacer"></span>
            ${this.flashed
              ? html`<button class="btn cta" @click=${this.next}>continue ▸</button>`
              : html`<button class="btn cta" @click=${this.doFlash} ?disabled=${!this.port || this.flashing}>${cta}</button>`}
          </div>
        </div>
      </div></div>`;
  }

  private stepConnect() {
    const p = this.provisioned;
    const role = p?.role ?? null;
    const cta = this.provisioning ? 'provisioning…' : p ? 'provisioned ✓' : 'connect';
    return html`<div class="card">${this.header('connect')}
      <div class="card-body wide">
        <h3>Connect it to Wi-Fi</h3>
        <p>Enter your network once — every node reuses it. ThroughNet assigns roles automatically: the first board is the TX illuminator, the rest are RX, locked to the TX. (A board already on record keeps its saved network.)</p>
        <div class="field"><label>wi-fi network</label><input type="text" placeholder="your 2.4 GHz network" .value=${this.ssid} @input=${(e: Event) => (this.ssid = (e.target as HTMLInputElement).value)}></div>
        <div class="field"><label>password</label><input type="password" placeholder="leave blank to reuse saved" .value=${this.password} @input=${(e: Event) => (this.password = (e.target as HTMLInputElement).value)}></div>
        ${this.provError ? html`<div class="check fail" style="margin:4px 0 12px"><span class="mk">✕</span><div><div class="lbl">provision failed</div><div class="sub">${this.provError}</div></div></div>` : ''}
        ${p ? html`<div class="fleet"><div class="nd"><span class="gem ${role === 'tx' ? 'tx' : 'rx'}"></span> node ${p.nodeId ?? '?'} <span class="role">${role ?? 'rx'}${role === 'tx' ? ' · illuminator' : ''}</span> <span class="spacer"></span><code class="cmd">provisioned ✓</code></div></div>` : ''}
        <div class="actions">
          <button class="btn ghost" @click=${this.back}>back</button>
          <span class="spacer"></span>
          ${p
            ? html`<button class="btn cta" @click=${this.next}>continue ▸</button>`
            : html`<button class="btn cta" @click=${this.doProvision} ?disabled=${this.provisioning || !this.port}>${cta}</button>`}
        </div>
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
