// <tn-devices> — the fleet management console (ADR-151 fleet mgmt). Distinct
// from <tn-nodes> (live sensing health): this is for *controlling the hardware*
// — see every board the system knows (provisioned ∪ streaming), assign roles,
// flash, and re-provision, whenever you want. Driven by the reconciler
// (/api/v1/setup/fleet); USB probing is on-demand (scanning resets boards, so
// we never do it on the live poll). ?mock swaps in MOCK_FLEET.
import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  fetchFleet, flashBoard, provisionBoard, updateOta, MOCK_FLEET,
  type FleetReport, type FleetDevice,
} from '../onboarding/tn-setup';

const isMock = () => new URLSearchParams(location.search).has('mock');

@customElement('tn-devices')
export class TnDevices extends LitElement {
  protected createRenderRoot() { return this; }

  @state() private fleet?: FleetReport;
  @state() private loading = true;
  @state() private scanning = false;
  @state() private err = false;
  @state() private open?: string;            // expanded device (keyOf)
  @state() private busy = '';                // 'flash' | 'provision' | 'ota' while in flight
  @state() private actionMsg?: { ok: boolean; text: string };
  @state() private reflashArm = false;       // TX/known-board re-flash confirm
  @state() private otaArm = false;            // network-OTA confirm (node reboots)
  // re-provision form (seeded from the device when its panel opens)
  @state() private fSsid = '';
  @state() private fPassword = '';
  @state() private fRole = '';               // '' = auto, 'tx', 'rx'

  private timer?: ReturnType<typeof setInterval>;

  connectedCallback() {
    super.connectedCallback();
    this.refresh();
    // Fast reconciler only (state ∪ live) — never auto-scan USB (that resets boards).
    this.timer = setInterval(() => { if (!this.busy && !this.scanning) this.refresh(); }, 3000);
  }
  disconnectedCallback() { super.disconnectedCallback(); clearInterval(this.timer); }

  private keyOf(d: FleetDevice) { return String(d.nodeId ?? d.port ?? '?'); }

  private async refresh() {
    if (isMock()) { this.fleet = MOCK_FLEET; this.loading = false; return; }
    try { this.fleet = await fetchFleet(false); this.err = false; }
    catch { this.err = true; }
    finally { this.loading = false; }
  }

  private async scanUsb() {
    this.scanning = true; this.actionMsg = undefined;
    try { this.fleet = isMock() ? MOCK_FLEET : await fetchFleet(true); this.err = false; }
    catch { this.err = true; }
    finally { this.scanning = false; }
  }

  private toggle(d: FleetDevice) {
    const k = this.keyOf(d);
    if (this.open === k) { this.open = undefined; return; }
    this.open = k; this.reflashArm = false; this.otaArm = false; this.actionMsg = undefined;
    this.fSsid = d.ssid ?? ''; this.fPassword = ''; this.fRole = d.role ?? '';
  }

  private async doFlash(d: FleetDevice) {
    if (!d.port) return;
    this.busy = 'flash'; this.actionMsg = undefined;
    try {
      const r = isMock() ? (await this.delay(900), { success: true }) : await flashBoard(d.port);
      this.actionMsg = r.success ? { ok: true, text: 'firmware flashed ✓' } : { ok: false, text: r.error ?? 'flash failed' };
      this.reflashArm = false;
      if (r.success && !isMock()) await this.scanUsb();
    } catch (e) { this.actionMsg = { ok: false, text: String(e) }; }
    finally { this.busy = ''; }
  }

  private async doProvision(d: FleetDevice) {
    if (!d.port) return;
    this.busy = 'provision'; this.actionMsg = undefined;
    try {
      const r = isMock()
        ? (await this.delay(900), { success: true, role: this.fRole || d.role || 'rx', nodeId: d.nodeId ?? 4 })
        : await provisionBoard({ port: d.port, ssid: this.fSsid, password: this.fPassword, role: this.fRole || undefined });
      this.actionMsg = r.success
        ? { ok: true, text: `provisioned ✓ · node ${r.nodeId ?? '?'} · ${r.role ?? 'rx'}${r.otaEnabled ? ' · OTA enabled' : ''}` }
        : { ok: false, text: r.error ?? 'provision failed' };
      if (r.success && !isMock()) await this.scanUsb();
    } catch (e) { this.actionMsg = { ok: false, text: String(e) }; }
    finally { this.busy = ''; }
  }

  private async doOta(d: FleetDevice) {
    if (d.nodeId == null) return;
    this.busy = 'ota'; this.actionMsg = undefined;
    try {
      const r = isMock()
        ? (await this.delay(1400), { success: true, bytes: 786432, message: 'firmware pushed — node rebooting to the new image' })
        : await updateOta(d.nodeId);
      this.actionMsg = r.success
        ? { ok: true, text: r.message ?? 'firmware pushed — node rebooting' }
        : { ok: false, text: r.error ?? 'OTA failed' };
      this.otaArm = false;
      // The node reboots; let it drop offline then come back before we re-poll.
      if (r.success && !isMock()) { await this.delay(1500); this.refresh(); }
    } catch (e) { this.actionMsg = { ok: false, text: String(e) }; }
    finally { this.busy = ''; }
  }

  private delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

  private renderOta(d: FleetDevice): TemplateResult {
    const busy = !!this.busy;
    if (!d.otaReady) {
      const why = d.role === 'tx' ? 'the illuminator can only be updated over USB (it sends no CSI, so we never learn its IP)'
        : !d.hasOtaPsk ? 're-provision this board once over USB to enable network updates'
        : 'the node must be online (streaming) to update it over the network';
      return html`<button class="dv-btn ghost" disabled title=${why}>update (OTA)</button>`;
    }
    return this.otaArm
      ? html`<button class="dv-btn danger" @click=${() => this.doOta(d)} ?disabled=${busy}>${this.busy === 'ota' ? 'updating…' : 'confirm update'}</button>
             <button class="dv-btn ghost" @click=${() => (this.otaArm = false)} ?disabled=${busy}>cancel</button>`
      : html`<button class="dv-btn" @click=${() => (this.otaArm = true)} ?disabled=${busy}>update (OTA)</button>`;
  }

  render() {
    const f = this.fleet;
    const s = f?.summary;
    return html`<div class="tn-screen"><div class="tn-sheet">
      <h2>devices ${s ? `· ${s.known} known · ${s.online} online` : ''}</h2>
      <div class="body">
        <div class="dv-toolbar">
          <p class="muted" style="margin:0;flex:1">
            ${s?.healthy ? 'mesh healthy — illuminator + receiver streaming'
              : 'manage your boards — flash, set roles, re-provision'}
          </p>
          <button class="dv-btn" @click=${this.scanUsb} ?disabled=${this.scanning || !!this.busy}>
            ${this.scanning ? 'scanning…' : 'scan USB'}</button>
        </div>
        ${this.err ? html`<p class="muted">couldn't reach the setup service — is ThroughNet running?</p>` : ''}
        ${this.loading && !f ? html`<p class="muted">loading fleet…</p>` : ''}
        ${f && f.devices.length === 0 && !this.scanning
          ? html`<p class="muted">no boards yet — plug an ESP32-S3 in via USB and hit <b>scan USB</b>.</p>` : ''}
        ${(f?.devices ?? []).map((d) => this.renderDevice(d))}
      </div>
    </div></div>`;
  }

  private renderDevice(d: FleetDevice): TemplateResult {
    const tx = d.role === 'tx';
    const open = this.open === this.keyOf(d);
    const pill = d.bucket === 'streaming' ? html`<span class="tn-pill ok">streaming</span>`
      : d.bucket === 'illuminating' ? html`<span class="tn-pill ok">beaconing</span>`
      : d.bucket === 'provisioned' ? html`<span class="tn-pill warn">offline</span>`
      : html`<span class="tn-pill bad">needs setup</span>`;
    const link = d.online && d.rssiDbm != null
      ? `${d.rssiDbm.toFixed(0)} dBm${d.csiFps != null ? ' · ' + d.csiFps.toFixed(0) + ' Hz' : ''}`
      : d.linkUp ? 'beaconing'
      : d.present ? `on ${d.port}` : 'offline';
    return html`
      <div class="dv-row ${open ? 'open' : ''}" @click=${() => this.toggle(d)}>
        <span class="gem ${tx ? 'tx' : 'rx'} ${d.linkUp ? 'present' : ''}"></span>
        <div>
          <div class="v">${d.nodeId != null ? `node ${d.nodeId}` : 'new board'}</div>
          <div class="k">${d.role ?? 'unprovisioned'}${tx ? ' · illuminator' : ''}${d.present ? ' · USB' : ''}</div>
        </div>
        <div><div class="k">link</div><div class="v">${link}</div></div>
        <div>${pill}</div>
        <span class="dv-caret">${open ? '▾' : '▸'}</span>
      </div>
      ${open ? this.renderActions(d) : ''}`;
  }

  private renderActions(d: FleetDevice): TemplateResult {
    const tx = d.role === 'tx';
    const present = d.present && !!d.port;
    const busy = !!this.busy;
    return html`<div class="dv-actions" @click=${(e: Event) => e.stopPropagation()}>
      ${!present ? html`
        ${d.otaReady ? html`
          <p class="muted">deployed and streaming — push a firmware update over the network, no USB needed. The node A/B-flashes and reboots to the new image (~20&nbsp;s offline, with rollback if it fails to boot).</p>
          <div class="dv-btns"><span style="flex:1"></span>${this.renderOta(d)}</div>`
        : html`
          <p class="muted">
            ${d.online ? 'online and streaming — nothing to do. '
              : d.linkUp ? 'this illuminator is up — beaconing. nothing to do. ' : ''}${!d.hasOtaPsk && d.role !== 'tx' ? 're-provision once over USB to enable network (OTA) updates. ' : ''}plug this board into USB and hit
            <b>scan USB</b> above to flash or re-provision it.
          </p>`}` : html`
        ${tx ? html`<div class="dv-warn">⚠ this is your TX illuminator — re-flashing reboots the beacon and every receiver goes dark for ~20&nbsp;s while it returns. Re-provisioning is safe.</div>` : ''}
        <div class="dv-form">
          <label>wi-fi<input type="text" .value=${this.fSsid} placeholder=${d.ssid ?? 'network'}
            @input=${(e: Event) => (this.fSsid = (e.target as HTMLInputElement).value)}></label>
          <label>password<input type="password" .value=${this.fPassword} placeholder="reuse saved"
            @input=${(e: Event) => (this.fPassword = (e.target as HTMLInputElement).value)}></label>
          <label>role
            <select @change=${(e: Event) => (this.fRole = (e.target as HTMLSelectElement).value)}>
              <option value="" ?selected=${this.fRole === ''}>auto</option>
              <option value="tx" ?selected=${this.fRole === 'tx'}>TX · illuminator</option>
              <option value="rx" ?selected=${this.fRole === 'rx'}>RX · receiver</option>
            </select></label>
        </div>
        <div class="dv-btns">
          <button class="dv-btn" @click=${() => this.doProvision(d)} ?disabled=${busy}>
            ${this.busy === 'provision' ? 'provisioning…' : d.provisioned ? 're-provision' : 'provision'}</button>
          ${d.provisioned
            ? (this.reflashArm
                ? html`<button class="dv-btn danger" @click=${() => this.doFlash(d)} ?disabled=${busy}>${this.busy === 'flash' ? 'flashing…' : 'confirm re-flash'}</button>
                       <button class="dv-btn ghost" @click=${() => (this.reflashArm = false)} ?disabled=${busy}>cancel</button>`
                : html`<button class="dv-btn" @click=${() => (this.reflashArm = true)} ?disabled=${busy}>re-flash firmware</button>`)
            : html`<button class="dv-btn" @click=${() => this.doFlash(d)} ?disabled=${busy}>${this.busy === 'flash' ? 'flashing…' : 'flash firmware'}</button>`}
          <span style="flex:1"></span>
          <span class="muted" style="align-self:center;font-size:12px">on USB — flash here; OTA is for deployed nodes</span>
        </div>`}
      ${this.actionMsg ? html`<div class="dv-msg ${this.actionMsg.ok ? 'ok' : 'bad'}">${this.actionMsg.text}</div>` : ''}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap { 'tn-devices': TnDevices; }
}
