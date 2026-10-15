// Simulated phone: produces iOS-format samples (Euler attitude, deg/s gyro, gravity-free accel)
// with network delay/jitter, from mouse input or scripted swings. Lets the whole pipeline
// (fusion, calibration, arm model, physics) run and be tested without a phone.
import { Quaternion, Vector3 } from 'three';
import { Q_EW, yawQuat, poseFromDir } from './orient.js';
import { DEFAULT_GRIP } from './calib.js';
import { synthSample, bodyRate } from './synth.js';
import { STANCES, ArmModel } from './armmodel.js';

const DT = 1000 / 60;
const smooth = (x) => x * x * x * (x * (x * 6 - 15) + 10); // min-jerk

export { poseFromDir };

function slerpDir(a, b, t, out = new Vector3()) {
  const d = Math.max(-1, Math.min(1, a.dot(b)));
  const ang = Math.acos(d);
  if (ang < 1e-5) return out.copy(a);
  const s = Math.sin(ang);
  return out.copy(a).multiplyScalar(Math.sin((1 - t) * ang) / s).addScaledVector(b, Math.sin(t * ang) / s).normalize();
}

const V = (x, y, z) => new Vector3(x, y, z).normalize();

/** Scripted swings: blade path through directions; the edge leads along the path. */
export const SWINGS = {
  vertical:   { name: '내려베기',     path: [V(0, 0.55, 0.85), V(0, 1, -0.15), V(0, -0.45, -1)], dur: 0.30 },
  diagonal:   { name: '사선베기',     path: [V(0.42, 0.42, 0.8), V(0.5, 0.5, -0.7), V(-0.57, -0.57, -0.6)], dur: 0.30 },
  horizontal: { name: '수평베기',     path: [V(1, 0.1, 0.35), V(0.2, 0.08, -1), V(-1, 0.05, -0.3)], dur: 0.28 },
  rising:     { name: '올려베기',     path: [V(-0.6, -0.6, 0.4), V(0, -0.2, -1), V(0.6, 0.75, -0.3)], dur: 0.32 },
  thrust:     { name: '찌르기',       thrust: true, dur: 0.16 },
};

export class SimPhone {
  constructor(deliver) {
    this.deliver = deliver;             // (sample) => void
    this.enabled = false;
    this.yaw = 0; this.pitch = 0.35; this.roll = 0;
    // a slightly odd grip and an arbitrary heading reference, so calibration has work to do
    this.G = new Quaternion().setFromAxisAngle(V(1, 0.3, -0.2), 0.22).multiply(DEFAULT_GRIP);
    this.yawRef = Math.random() * Math.PI * 2;
    this.Y = yawQuat(this.yawRef);
    this.clock = () => performance.now(); // overridable for deterministic benches
    this.t0 = this.clock();
    this.tNext = 0;
    this.queue = [];
    this.qPrev = null;
    this.pos = [new Vector3(), new Vector3(), new Vector3()]; // hand position history (body frame)
    this.arm = new ArmModel();
    this.armSwing = 1; // 1 = swings move the whole arm, 0 = wrist only (hand stays put)
    this.trans = new Vector3();
    this.action = null;                 // { kind, t0, ... }
    this.override = null;               // Quaternion (body frame) when scripted
    this.net = { base: 7, jitter: 4, spikeProb: 0.004, spike: 60 };
    this.noise = { gyroNoise: 0.015, oriNoiseDeg: 0.15, accNoise: 0.08 };
    this.stick = { x: 0, y: 0 };
    this.buttons = 0;
  }

  /** Mouse-driven pose (body frame). Pitch may exceed 90° to go over the head. */
  mousePose(out) {
    const q = yawQuat(this.yaw, out);
    q.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), this.pitch));
    q.multiply(poseFromDir(new Vector3(0, 0, -1), new Vector3(0, -1, 0)));
    q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), this.roll));
    return q;
  }

  mouse(dx, dy) {
    this.yaw -= dx * 0.004;
    this.pitch = Math.max(-1.45, Math.min(2.6, this.pitch - dy * 0.004));
    this.action = null; this.override = null;
  }
  wheel(d) { this.roll += d * 0.0025; }

  /** Smoothly move to a held pose (for calibration). */
  hold(dir, edge, dur = 0.7) {
    const from = this._currentPose();
    this.action = { kind: 'hold', t0: this._now(), dur, from, to: poseFromDir(dir, edge) };
  }

  /** Copy a shown pose like a person would: smoothly, with a few degrees of error. */
  holdPose(q, errDeg = 4, dur = 0.8, trans = null) {
    const ax = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const to = new Quaternion().setFromAxisAngle(ax, (Math.random() * errDeg * Math.PI) / 180).multiply(q);
    // optional hand shift (body frame), eased in like a person moving the arms into a guard
    this.action = { kind: 'hold', t0: this._now(), dur, from: this._currentPose(), to, transFrom: this._lastTrans || new Vector3(), transTo: trans || new Vector3() };
  }

  holdForCalib(step) {
    const n = () => (Math.random() - 0.5) * 0.12;
    if (step === 'fwd') this.hold(V(n(), 0.05 + n(), -1), V(0, -1, 0));
    else if (step === 'up') this.hold(V(n(), 1, -0.08 + n()), V(0, 0, -1));
    else {
      const s = STANCES.find((x) => x.id === step);
      if (s) this.hold(s.dir.clone().add(new Vector3(n(), n(), n())).normalize());
    }
  }

  swing(name, edgeErrorDeg = 0) {
    const sw = SWINGS[name];
    if (!sw) return;
    const t0 = this._now();
    if (sw.thrust) {
      this.action = { kind: 'thrust', t0, dur: sw.dur, from: this._currentPose(), to: poseFromDir(V(0, 0.15, -1), V(0, -1, 0)) };
      return;
    }
    // wind-up to the first path point, then the cut, then recover to middle guard
    this.action = { kind: 'swing', t0, sw, edgeErr: (edgeErrorDeg * Math.PI) / 180, from: this._currentPose(), windup: 0.45, recover: 0.6 };
  }

  _now() { return this.clock(); }

  _currentPose() { return (this.override || this.mousePose(new Quaternion())).clone(); }

  _pathAt(sw, u, edgeErr) {
    const n = sw.path.length - 1;
    const x = Math.min(n - 1e-6, u * n);
    const i = Math.floor(x);
    const dir = slerpDir(sw.path[i], sw.path[i + 1], x - i);
    // edge = direction of travel (central difference, clamped to the path)
    const at = (y) => { y = Math.max(0, Math.min(n - 1e-6, y)); const k = Math.floor(y); return slerpDir(sw.path[k], sw.path[k + 1], y - k); };
    const edge = at(x + 0.02).sub(at(x - 0.02));
    if (edge.lengthSq() < 1e-8) edge.set(0, -1, 0);
    const q = poseFromDir(dir, edge);
    if (edgeErr) q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), edgeErr));
    return q;
  }

  /** Pure: intended pose (body frame) + hand translation at time t (ms) for the current action. */
  poseAt(t) {
    const a = this.action;
    const trans = new Vector3();
    if (!a) return { q: this.override || this.mousePose(new Quaternion()), trans, done: false };
    const el = (t - a.t0) / 1000;
    if (a.kind === 'hold') {
      const u = smooth(Math.min(1, el / a.dur));
      if (a.transTo) trans.lerpVectors(a.transFrom, a.transTo, u);
      return { q: a.from.clone().slerp(a.to, u), trans, done: false };
    }
    if (a.kind === 'thrust') {
      const q = a.from.clone().slerp(a.to, smooth(Math.min(1, el / 0.25)));
      const tt = el - 0.25, out = 0.36;
      let done = false;
      if (tt > 0) {
        if (tt < a.dur) trans.set(0, 0, -out * smooth(tt / a.dur));
        else if (tt < a.dur + 0.35) trans.set(0, 0, -out * (1 - smooth((tt - a.dur) / 0.35)));
        else done = true;
      }
      return { q, trans, done };
    }
    // swing: wind-up, cut, recover to middle guard
    const start = this._pathAt(a.sw, 0, a.edgeErr);
    const end = this._pathAt(a.sw, 1, a.edgeErr);
    if (el < a.windup) return { q: a.from.clone().slerp(start, smooth(Math.max(0, el) / a.windup)), trans, done: false };
    const e2 = el - a.windup;
    if (e2 < a.sw.dur) return { q: this._pathAt(a.sw, smooth(e2 / a.sw.dur), a.edgeErr), trans, done: false };
    const e3 = e2 - a.sw.dur;
    const mid = poseFromDir(V(0, 0.35, -1), V(0, -1, 0));
    if (e3 < a.recover) return { q: end.clone().slerp(mid, smooth(e3 / a.recover)), trans, done: false };
    return { q: mid, trans, done: true };
  }

  _advance(t) {
    const p = this.poseAt(t);
    this.trans.copy(p.trans);
    this._lastTrans = p.trans.clone();
    if (!this.action) { this.override = null; return; }
    this.override = p.q;
    if (p.done) {
      if (this.action.kind === 'swing') { this.yaw = 0; this.pitch = 0.35; this.roll = 0; }
      this.action = null;
    }
  }

  setEnabled(v) {
    if (v && !this.enabled) { this.t0 = this.clock(); this.tNext = 0; this.queue = []; this.qPrev = null; this._posInit = false; }
    this.enabled = v;
  }

  update(now) {
    if (!this.enabled) return;
    const tRel = now - this.t0;
    if (tRel - this.tNext > 250) this.tNext = tRel - DT; // tab was hidden: a real phone would not backfill
    let guard = 0;
    while (this.tNext <= tRel && guard++ < 20) {
      const t = this.tNext;
      this._advance(this.t0 + t);
      const S = this._currentPose();
      // device attitude realizing S under the hidden grip/heading
      const qDev = Q_EW.clone().invert().multiply(this.Y.clone().invert()).multiply(S).multiply(this.G.clone().invert());
      const w = this.qPrev ? bodyRate(this.qPrev, qDev, DT / 1000) : new Vector3();
      this.qPrev = qDev;
      // translation -> acceleration (world body frame) -> earth frame
      // the simulated hand travels where the arm model says (a whole-arm swing) plus any thrust,
      // so the accelerometer sees what a real arm swing produces
      // instantaneous acceleration (like a real accelerometer), not a 60 Hz second difference — the
      // latter aliases fast swings into huge spikes
      const tt = this.t0 + t, hh = 2;
      const handAt = (x) => {
        const p = this.poseAt(x);
        return this.arm.baseGrip(new Vector3(0, 1, 0).applyQuaternion(p.q), new Vector3()).multiplyScalar(this.armSwing).add(p.trans);
      };
      const aW = this.action
        ? handAt(tt + hh).sub(handAt(tt).multiplyScalar(2)).add(handAt(tt - hh)).multiplyScalar(1 / ((hh / 1000) ** 2))
        : new Vector3();
      const aE = aW.applyQuaternion(this.Y.clone().multiply(Q_EW).invert());
      const s = synthSample(t, qDev, w, aE, this.noise);
      s.stickX = this.stick.x; s.stickY = this.stick.y; s.buttons = this.buttons;
      let delay = this.net.base + Math.random() * this.net.jitter;
      if (Math.random() < this.net.spikeProb) delay += this.net.spike * Math.random();
      s.recv = this.t0 + t + delay;
      s.t = t; // phone clock: ms since sim start
      this.queue.push(s);
      this.tNext += DT + (Math.random() - 0.5) * 1.5;
    }
    // TCP keeps order: a delayed packet holds back the ones behind it
    while (this.queue.length && this.queue[0].recv <= now) {
      const s = this.queue.shift();
      s.recv = now;
      this.deliver(s);
    }
  }
}
