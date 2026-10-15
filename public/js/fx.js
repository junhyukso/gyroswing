// Game feel: swing trail, sparks/chips/straw particles, procedural audio, hit-stop, camera shake.
import * as THREE from 'three';

// ------------------------------------------------------------------ trail
export class Trail {
  constructor(scene, n = 44) {
    this.n = n;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(n * 2 * 3);
    this.col = new Float32Array(n * 2 * 4);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    this.life = 0.11;
    // ring buffer of samples (pushed at physics rate: no per-sample allocation)
    const mk = () => ({ t: -1e9, base: new THREE.Vector3(), tip: new THREE.Vector3(), speed: 0 });
    this.ring = Array.from({ length: n }, mk);
    this.head = 0;
    this.count = 0;
    this._list = [];
    this._lead = mk();
  }
  push(t, base, tip, speed) {
    const s = this.ring[this.head];
    s.t = t; s.base.copy(base); s.tip.copy(tip); s.speed = speed;
    this.head = (this.head + 1) % this.n;
    this.count = Math.min(this.count + 1, this.n);
  }
  /**
   * lead (optional): the blade as drawn this frame ({ t, base, tip }) — the sword is drawn between
   * physics steps, so samples newer than it are dropped and the trail ends exactly at the blade.
   */
  update(t, cam, lead = null) {
    const s = this._list;
    s.length = 0;
    for (let i = this.count; i >= 1; i--) {
      const x = this.ring[(this.head - i + this.n) % this.n];
      if (t - x.t < this.life && (!lead || x.t < lead.t)) s.push(x);
    }
    if (lead && s.length) {
      const L = this._lead;
      L.t = lead.t; L.base.copy(lead.base); L.tip.copy(lead.tip); L.speed = s[s.length - 1].speed;
      s.push(L);
    }
    const near = (p) => {
      if (!cam) return 1;
      const d = p.distanceTo(cam);
      const k = Math.max(0, Math.min(1, (d - 0.35) / 0.45));
      return k * k * (3 - 2 * k);
    };
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const k = Math.max(0, s.length - n + i);
      const x = s[Math.min(k, s.length - 1)];
      const o = i * 6, c = i * 8;
      if (!x) { this.pos.fill(0, o, o + 6); this.col.fill(0, c, c + 8); continue; }
      this.pos[o] = x.base.x; this.pos[o + 1] = x.base.y; this.pos[o + 2] = x.base.z;
      this.pos[o + 3] = x.tip.x; this.pos[o + 4] = x.tip.y; this.pos[o + 5] = x.tip.z;
      const age = (t - x.t) / this.life;
      const a = Math.max(0, Math.min(1, (x.speed - 9) / 12)) * (1 - age) * 0.22;
      const col = this.col;
      col[c] = 0.85; col[c + 1] = 0.9; col[c + 2] = 1; col[c + 3] = a * 0.1 * near(x.base);
      col[c + 4] = 0.9; col[c + 5] = 0.94; col[c + 6] = 1; col[c + 7] = a * near(x.tip);
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ particles
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.6)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

class Pool {
  constructor(scene, max, { size, additive = false, gravity = -9.8, drag = 0.5, streak = false }) {
    this.max = max; this.gravity = gravity; this.drag = drag; this.streak = streak;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3);
    this.life = new Float32Array(max); this.age = new Float32Array(max); this.rgb = new Float32Array(max * 3);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    const verts = streak ? max * 2 : max;
    this.gp = new Float32Array(verts * 3);
    this.gc = new Float32Array(verts * 4);
    g.setAttribute('position', new THREE.BufferAttribute(this.gp, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.gc, 4).setUsage(THREE.DynamicDrawUsage));
    const blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.obj = streak
      ? new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending }))
      : new THREE.Points(g, new THREE.PointsMaterial({ size, map: dotTexture(), vertexColors: true, transparent: true, depthWrite: false, blending, sizeAttenuation: true }));
    this.obj.frustumCulled = false;
    scene.add(this.obj);
  }
  emit(pos, vel, life, color) {
    const i = this.next; this.next = (this.next + 1) % this.max;
    this.p.set([pos.x, pos.y, pos.z], i * 3); this.v.set([vel.x, vel.y, vel.z], i * 3);
    this.life[i] = life; this.age[i] = 0; this.rgb.set(color, i * 3);
  }
  update(dt, floorY = 0.005) {
    const drag = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.max; i++) {
      const o = i * 3;
      if (this.age[i] >= this.life[i]) {
        if (this.streak) { this.gc.fill(0, i * 8, i * 8 + 8); } else this.gc[i * 4 + 3] = 0;
        continue;
      }
      this.age[i] += dt;
      this.v[o + 1] += this.gravity * dt;
      for (let k = 0; k < 3; k++) { this.v[o + k] *= drag; this.p[o + k] += this.v[o + k] * dt; }
      if (this.p[o + 1] < floorY) { this.p[o + 1] = floorY; this.v[o] *= 0.3; this.v[o + 1] *= -0.2; this.v[o + 2] *= 0.3; }
      const a = 1 - this.age[i] / this.life[i];
      if (this.streak) {
        const j = i * 6;
        this.gp[j] = this.p[o]; this.gp[j + 1] = this.p[o + 1]; this.gp[j + 2] = this.p[o + 2];
        this.gp[j + 3] = this.p[o] - this.v[o] * 0.012; this.gp[j + 4] = this.p[o + 1] - this.v[o + 1] * 0.012; this.gp[j + 5] = this.p[o + 2] - this.v[o + 2] * 0.012;
        this.gc.set([this.rgb[o], this.rgb[o + 1], this.rgb[o + 2], a, this.rgb[o], this.rgb[o + 1] * 0.6, this.rgb[o + 2] * 0.3, 0], i * 8);
      } else {
        this.gp[o] = this.p[o]; this.gp[o + 1] = this.p[o + 1]; this.gp[o + 2] = this.p[o + 2];
        this.gc.set([this.rgb[o], this.rgb[o + 1], this.rgb[o + 2], Math.min(1, a * 1.5)], i * 4);
      }
    }
    this.obj.geometry.attributes.position.needsUpdate = true;
    this.obj.geometry.attributes.color.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ audio
class Sfx {
  constructor() { this.ctx = null; this.volume = 0.8; }
  unlock() {
    if (this.ctx) { this.ctx.resume(); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.master = ctx.createGain(); this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // continuous whoosh driven by blade speed
    const src = ctx.createBufferSource(); src.buffer = this.noise; src.loop = true;
    this.wf = ctx.createBiquadFilter(); this.wf.type = 'bandpass'; this.wf.Q.value = 1.4; this.wf.frequency.value = 400;
    this.wg = ctx.createGain(); this.wg.gain.value = 0;
    src.connect(this.wf).connect(this.wg).connect(this.master);
    src.start();
  }
  get ok() { return this.ctx && this.ctx.state === 'running'; }

  whoosh(speed) {
    if (!this.ok) return;
    const t = this.ctx.currentTime;
    const x = Math.max(0, speed - 5);
    this.wf.frequency.setTargetAtTime(250 + x * 55, t, 0.02);
    this.wg.gain.setTargetAtTime(Math.min(0.5, Math.pow(x / 16, 1.6) * 0.5), t, 0.025);
  }

  _noise(t, dur, type, f0, f1, q, gain, attack = 0.002) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource(); s.buffer = this.noise;
    s.playbackRate.value = 0.9 + Math.random() * 0.2;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random() * 1.5); s.stop(t + dur + 0.05);
  }
  _tone(t, freq, dur, gain, type = 'sine', fEnd = null) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (fEnd) o.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  play(kind, k = 1) {
    if (!this.ok) return;
    const t = this.ctx.currentTime + 0.001;
    k = Math.max(0.05, Math.min(1.5, k));
    switch (kind) {
      case 'cut':
        this._noise(t, 0.12, 'highpass', 1800, 6500, 0.8, 0.55 * k);
        this._noise(t, 0.05, 'bandpass', 3500, 2500, 2, 0.4 * k);
        this._tone(t, 160, 0.07, 0.15 * k, 'sine', 90);
        break;
      case 'wood':
        this._noise(t, 0.08, 'bandpass', 900, 500, 1.6, 0.7 * k);
        this._noise(t, 0.012, 'highpass', 5000, 4000, 0.7, 0.35 * k);
        this._tone(t, 150 + Math.random() * 30, 0.14, 0.35 * k, 'sine', 85);
        break;
      case 'straw':
        this._noise(t, 0.1, 'lowpass', 900, 300, 0.7, 0.55 * k);
        this._tone(t, 110, 0.09, 0.2 * k, 'sine', 70);
        break;
      case 'leather':
        this._noise(t, 0.12, 'lowpass', 500, 160, 0.8, 0.8 * k);
        this._tone(t, 75, 0.16, 0.5 * k, 'sine', 50);
        break;
      case 'metal': {
        const f0 = 480 + Math.random() * 120;
        [[1, 1, 1.3], [2.32, 0.55, 0.9], [4.25, 0.4, 0.6], [6.63, 0.25, 0.4], [9.38, 0.15, 0.25]]
          .forEach(([r, g, d]) => this._tone(t, f0 * r, d * (0.6 + k * 0.4), 0.16 * g * k));
        this._noise(t, 0.03, 'highpass', 4000, 3000, 0.7, 0.5 * k);
        break;
      }
      case 'ground':
        this._noise(t, 0.09, 'lowpass', 600, 200, 0.7, 0.4 * k);
        break;
      case 'hurt':
        this._noise(t, 0.18, 'lowpass', 400, 120, 0.8, 0.9 * k);
        this._tone(t, 60, 0.3, 0.6 * k, 'sine', 40);
        break;
      case 'swish': // an attacker's blade cutting the air
        this._noise(t, 0.28, 'bandpass', 500, 2600, 1.2, 0.35 * k, 0.08);
        break;
      case 'chime':
        this._tone(t, 880, 0.35, 0.12); this._tone(t + 0.07, 1320, 0.45, 0.1);
        break;
      case 'tick':
        this._tone(t, 1600, 0.04, 0.06, 'square');
        break;
      case 'error':
        this._tone(t, 220, 0.25, 0.14, 'sawtooth', 160);
        break;
    }
  }
}

// ------------------------------------------------------------------ facade
export class FX {
  constructor(scene) {
    this.scene = scene;
    this.trail = new Trail(scene);
    this.sparks = new Pool(scene, 300, { additive: true, gravity: -6, drag: 1.2, streak: true });
    this.chips = new Pool(scene, 400, { size: 0.018, gravity: -9.8, drag: 0.8 });
    this.dust = new Pool(scene, 200, { size: 0.09, gravity: 0.2, drag: 2.5 });
    this.sfx = new Sfx();
    this.hitStopUntil = 0;
    this.hitStopScale = 1;
    this.shakeAmt = 0;
    this.shakeOff = new THREE.Vector3();
    this.params = { hitStop: true, shake: true };
  }

  timeScale(now) { return now < this.hitStopUntil ? this.hitStopScale : 1; }
  hitStop(now, ms, scale = 0.08) {
    if (!this.params.hitStop) return;
    this.hitStopUntil = Math.max(this.hitStopUntil, now + ms);
    this.hitStopScale = scale;
  }
  shake(a) { if (this.params.shake) this.shakeAmt = Math.min(0.03, this.shakeAmt + a); }

  burst(kind, p, n, dir = null, speed = 2) {
    const rnd = () => new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2);
    for (let i = 0; i < n; i++) {
      const v = rnd().multiplyScalar(speed);
      if (dir) v.addScaledVector(dir, speed * (0.6 + Math.random()));
      if (kind === 'spark') this.sparks.emit(p, v.multiplyScalar(2.5), 0.15 + Math.random() * 0.3, [1, 0.75 + Math.random() * 0.2, 0.4]);
      else if (kind === 'wood') this.chips.emit(p, v, 0.6 + Math.random() * 0.8, [0.45 + Math.random() * 0.15, 0.32, 0.18]);
      else if (kind === 'straw') this.chips.emit(p, v.multiplyScalar(0.8), 0.8 + Math.random(), [0.78 + Math.random() * 0.1, 0.7, 0.4]);
      else if (kind === 'dust') this.dust.emit(p, v.multiplyScalar(0.3), 0.6 + Math.random() * 0.6, [0.62, 0.55, 0.42]);
    }
  }

  update(dt, t, cam = null, lead = null) {
    this.trail.update(t, cam, lead);
    this.sparks.update(dt); this.chips.update(dt); this.dust.update(dt);
    this.shakeAmt *= Math.exp(-dt * 14);
    const a = this.shakeAmt;
    this.shakeOff.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
  }
}
