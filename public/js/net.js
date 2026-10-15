// Game-side link to the relay server: decodes phone sensor packets, measures RTT,
// forwards prompts/haptics to the phone, and records sessions for offline tuning.
export const PKT = 80;

export function decodePacket(buf, recv) {
  const dv = new DataView(buf);
  if (dv.byteLength < PKT || dv.getUint8(0) !== 1) return null;
  return {
    flags: dv.getUint8(1),
    seq: dv.getUint16(2, true),
    t: dv.getFloat64(4, true),
    alpha: dv.getFloat32(12, true), beta: dv.getFloat32(16, true), gamma: dv.getFloat32(20, true),
    rrA: dv.getFloat32(24, true), rrB: dv.getFloat32(28, true), rrG: dv.getFloat32(32, true),
    ax: dv.getFloat32(36, true), ay: dv.getFloat32(40, true), az: dv.getFloat32(44, true),
    gx: dv.getFloat32(48, true), gy: dv.getFloat32(52, true), gz: dv.getFloat32(56, true),
    interval: dv.getFloat32(60, true),
    oriAge: dv.getFloat32(64, true),
    stickX: dv.getFloat32(68, true), stickY: dv.getFloat32(72, true),
    buttons: dv.getUint32(76, true),
    recv,
  };
}

export class Net {
  /** seat: multiplayer seat id — this link then gets only the phone opened from that seat's QR. */
  constructor({ seat = null } = {}) {
    this.seat = seat;
    this.closed = false;
    this.ws = null;
    this.serverPhones = 0;  // phones the relay server knows (WebSocket / HTTP paths)
    this.rtt = 0;
    this.onSample = null;   // (sample) => void
    this.onEvent = null;    // (msg) => void   phone text messages (btn, started, hello)
    this.onPhones = null;   // (count) => void
    this.lastSampleAt = -1e9; // (0 would read as "receiving" during the first 0.5 s after page load)
    this.seqLast = -1;
    this.lost = 0;
    this.recording = null;
    this.rtc = null;        // { id, pc, s, c } direct data channel to the phone
    // this page's id: the phone can be asked to open its data channel to exactly this page
    this.id = seat || Math.random().toString(36).slice(2, 10).padEnd(8, '0');
    this._born = performance.now();
    this._lastClaim = 0;
    this._claimTimer = setInterval(() => this._maybeClaim(), 1000);
    this._pingTimer = setInterval(() => this.send({ type: 'ping', t: performance.now() }), 1000);
    // Wi-Fi power save: a PC that only receives lets its radio doze between beacons (~100 ms) while the
    // access point holds the phone's packets — the 100–200 ms stalls (in steps of ~100 ms) in the
    // recordings. A tiny packet back every 10 ms keeps the radio awake. (The phone ignores it.)
    this._ka = new Uint8Array([0]);
    this._kaTimer = setInterval(() => this._keepAlive(), 10);
    this.connect();
  }

  get phones() { return Math.max(this.serverPhones, this.rtcOpen ? 1 : 0); }
  get rtcOpen() { return !!(this.rtc && this.rtc.c && this.rtc.c.readyState === 'open'); }
  /** How the phone's data reaches us right now. */
  get transport() { return this.rtcOpen ? 'WebRTC' : this.serverPhones ? '서버 중계' : '없음'; }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(`ws://${location.host}/ws?role=game${this.seat ? `&seat=${this.seat}` : ''}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') { this._onBinary(e.data); return; }
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'phones') { this.serverPhones = m.count; this.onPhones?.(this.phones); return; }
      if (m.type === 'rtc-offer') { this._answerRtc(m); return; }
      this._onText(m);
    };
    ws.onclose = () => { this.ws = null; if (!this.closed) setTimeout(() => this.connect(), 1000); };
    this.ws = ws;
  }

  _onBinary(buf) {
    const now = performance.now();
    const s = decodePacket(buf, now);
    if (!s) return;
    if (this.seqLast >= 0) {
      const gap = (s.seq - this.seqLast + 65536) & 0xffff;
      if (gap > 1 && gap < 1000) this.lost += gap - 1;
    }
    this.seqLast = s.seq;
    this.lastSampleAt = now;
    if (this.recording) this.recording.samples.push(s);
    this.onSample?.(s);
  }

  _onText(m) {
    const now = performance.now();
    if (m.type === 'pong') {
      this.rtt = now - m.t;
      this.send({ type: 'rtt', ms: this.rtt });
      return;
    }
    if (this.recording) this.recording.events.push({ ...m, recv: now });
    this.onEvent?.(m);
  }

  /**
   * The phone is connected but its data isn't reaching this page — it's streaming to another game page
   * over WebRTC (an old tab left open, a second window). The page the player is looking at asks the
   * phone to open a new data channel to it (targeted, so only this page answers).
   */
  _maybeClaim() {
    const now = performance.now();
    if (this.muted || !this.serverPhones || this.receiving || document.hidden) return;
    if (document.hasFocus && !document.hasFocus()) return; // two windows side by side: the one in use
    if (now - this._born < 3000 || now - this.lastSampleAt < 2500 || now - this._lastClaim < 6000) return;
    this._lastClaim = now;
    console.info('[net] phone connected but no data here — asking it to reconnect to this page');
    this.send({ type: 'rtc-reoffer', for: this.id });
  }

  _keepAlive() {
    if (this.muted || document.hidden || !this.rtcOpen) return;
    const s = this.rtc.s;
    if (s && s.readyState === 'open' && s.bufferedAmount < 64) { try { s.send(this._ka); } catch {} }
  }

  /** Phone offered a direct data channel: answer it (QA pages that are muted stay out of it). */
  async _answerRtc(m) {
    if (this.muted || !window.RTCPeerConnection) return;
    if (m.for ? m.for !== this.id : document.hidden) return; // targeted at another page / a hidden tab
    if (this.rtc) { try { this.rtc.pc.close(); } catch {} }
    const pc = new RTCPeerConnection({ iceServers: [] });
    const rtc = { id: m.id, pc, s: null, c: null };
    this.rtc = rtc;
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      ch.binaryType = 'arraybuffer';
      if (ch.label === 's') { rtc.s = ch; ch.onmessage = (ev) => this._onBinary(ev.data); }
      if (ch.label === 'c') {
        rtc.c = ch;
        ch.onmessage = (ev) => { try { this._onText(JSON.parse(ev.data)); } catch {} };
        ch.onopen = () => { console.info('[rtc] data channel open'); this.onPhones?.(this.phones); };
        ch.onclose = () => { if (this.rtc === rtc) this.rtc = null; this.onPhones?.(this.phones); };
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { if (this.rtc === rtc) this.rtc = null; this.onPhones?.(this.phones); }
    };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await new Promise((res) => {
        if (pc.iceGatheringState === 'complete') return res();
        const t = setTimeout(res, 1000);
        pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
      });
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'rtc-answer', id: m.id, from: this.id, sdp: pc.localDescription.sdp }));
    } catch (err) { console.warn('[rtc] answer failed', err); }
  }

  send(obj) {
    if (this.muted) return; // simulator mode: never drive a real phone that may be in someone's hand
    const text = JSON.stringify(obj);
    if (this.rtcOpen) { this.rtc.c.send(text); return; }
    if (this.ws && this.ws.readyState === 1) this.ws.send(text);
  }

  /** To the relay server itself (not the phone), e.g. claiming a ZIG SIM phone for this seat. */
  sendServer(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  /** Leave for good (a seat handed to another page): no reconnects, timers stopped. */
  close() {
    this.closed = true;
    clearInterval(this._claimTimer); clearInterval(this._pingTimer); clearInterval(this._kaTimer);
    if (this.rtc) { try { this.rtc.pc.close(); } catch {} this.rtc = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
  }

  prompt(title, text, opts = {}) { this.send({ type: 'prompt', title, text, ...opts }); }
  haptic(n = 1, gap = 45) { this.send({ type: 'haptic', n, gap }); }

  get receiving() { return performance.now() - this.lastSampleAt < 500; }

  startRecording(meta = {}) {
    this.recording = { version: 1, started: new Date().toISOString(), meta, samples: [], events: [] };
  }
  async stopRecording(extra = {}) {
    const rec = this.recording;
    this.recording = null;
    if (!rec) return null;
    Object.assign(rec, extra);
    const r = await fetch('/rec', { method: 'POST', body: JSON.stringify(rec) });
    return r.ok ? (await r.json()).name : null;
  }
}
