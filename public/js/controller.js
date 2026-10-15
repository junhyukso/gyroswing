// Turns phone samples into a sword target (grip position, orientation, velocities) in the
// player's body frame: fusion (attitude) -> calibration (grip + heading) -> arm model (hand).
import { Quaternion, Vector3 } from 'three';
import { Fusion } from './fusion.js';
import { Calibration } from './calib.js';
import { ArkitHand } from './arkit.js';
import { ArmModel } from './armmodel.js';
import { Q_EW, quatAngle } from './orient.js';

const STORE = 'gyrosword.calib.v2'; // v2: guided target-pose calibration
const MAP_STORE = 'gyrosword.gyromap.v1';
const _qDev = new Quaternion();
const _v = new Vector3();
const _d = new Vector3();
const _g = new Vector3();
const _e = new Vector3();
const _q2 = new Quaternion();
const _h = new Vector3();
const _x = new Vector3();
const _xe = new Vector3();
const _sp = new Vector3();
const smooth01 = (x) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };

export class Controller {
  /** store: suffix of the saved calibration's key (a second player on the same PC keeps their own). */
  constructor({ store = '' } = {}) {
    this._store = STORE + store; this._mapStore = MAP_STORE + store;
    this.fusion = new Fusion();
    this.calib = new Calibration();
    this.arm = new ArmModel();
    this.arkit = new ArkitHand();   // hand position from ARKit (ZIG SIM), while trustworthy
    this._arkOff = new Vector3(); this._arkRate = new Vector3();
    this.stick = { x: 0, y: 0 };
    this.buttons = 0;
    this.stillTime = 0;       // seconds the phone has been held still
    this.wSmooth = 0;
    this._tPrev = null;
    // tremor filter: one-euro style low-pass whose cutoff rises with angular speed, so a still hand
    // is steady but a swing passes through with no added lag
    this.params = {
      smoothMinHz: 2.0, smoothBeta: 10.0, // tremor filter, tuned on a real iPhone recording (tools/replay.mjs)
      bladeGate: true,
      // arm involvement: how fast the hand itself travels during the swing. Measured on the user's
      // iPhone: wrist flicks peak at ~1.0–1.4 m/s (the wrist pivot is ~10 cm from the phone), whole-arm
      // swings at ~2.5–3.5 m/s. (The lever radius |a|/√(ω⁴+α²) turned out NOT to separate them: a big
      // swing still ends in a wrist snap, so ω is large either way — kept for the HUD only.)
      involve: true, vWrist: 1.4, vArm: 2.8, wristR: 0.12, armR: 0.4, swingW0: 1.5, swingW1: 3.5, settleTau: 0.3,
      handModel: 'fused', // 'fused' (arm model + measured hand velocity) | 'gated' (older: rotation gates)
      // block poses (ArmModel.blockGrip) let go only in a full swing — a parry beat (a quick wrist
      // snap from the block, 5–10 rad/s) must keep the hands where the block put them
      blockW0: 10.0, blockW1: 16.0, // rad/s
      blockRise: 0.04, blockFall: 0.08, // s
      // block height assist: the gyro can't tell a head block from a body block (same wrist, hands
      // higher or lower), the game knows how high the attack comes — slide the hands up/down (at most
      // blockAssistMax) so the blade's strong half crosses that height. Only while in a block pose.
      blockAssist: 1.0, blockAssistMax: 0.25,
      // block poses only while an attack is coming (blockHint set): a backhand wind-up holds the sword
      // just like a block on the right (blade up-left, edge right) but with the hands on the left.
      // blockAlways (settings switch): also without an attack — then only while the sword is held or
      // moved slowly (blockIdleW0..W1), so a cut starting from a guard leaves it at once, and swings
      // passing through guard-like orientations don't drag the hands around
      blockAlways: false,
      blockIdleW0: 3.0, blockIdleW1: 6.0, // rad/s
      blockSide: 1.0, blockSideX: 0.34, // side blocks by intent (see target()); hands this far out (m)
      // with ZIG SIM's ARKit giving the real hand position, the block assists above (block poses, side
      // intent, height assist, guard layer) are switched off — they were stand-ins for a position the
      // gyro couldn't measure. true = keep them as a fallback for when ARKit isn't trusted.
      assistWithArkit: false,
    };
    this._qHist = [];
    this._swingV = new Vector3();
    this.handPeak = 0;        // peak hand speed in the current swing (m/s)
    this.leverR = 0.4;        // estimated lever radius of the current/last swing (m)
    this.involvement = 1;     // 0 = wrist only, 1 = whole arm
    this._hand = null;
    this._armPrev = new Vector3();
    this._qf = null;
    this._tf = 0;
    this._wf = new Vector3();
    this.blockW = 0;          // current weight of the block-pose hand placement
    this._guardOn = 0;
    this.blockHint = null;    // incoming attack, from the game: { y: height it crosses (body frame, m),
                              // side: -1 from the left / 1 from the right / 0 } — null = none (blocks off)
    this._blk = new Vector3();
    this.load();
  }

  load() {
    try {
      const o = JSON.parse(localStorage.getItem(this._store) || 'null');
      if (o) { this.calib.fromJSON(o.calib); this.arm.fromJSON(o.stances); }
      this.fusion.restoreMapping(JSON.parse(localStorage.getItem(this._mapStore) || 'null'));
    } catch {}
    // remember the gyro axis mapping once auto-detection confirms it (per browser/device)
    this.fusion.onMappingConfirmed = (m) => {
      try { localStorage.setItem(this._mapStore, JSON.stringify({ perm: m.perm, sign: m.sign, scale: m.scale, err: m.err })); } catch {}
    };
  }
  save() {
    try { localStorage.setItem(this._store, JSON.stringify({ calib: this.calib.toJSON(), stances: this.arm.toJSON() })); } catch {}
  }
  clearSaved() {
    try { localStorage.removeItem(this._store); } catch {}
  }

  get ready() { return this.fusion.ready; }

  push(s) {
    this.fusion.push(s);
    this._afterSample(s);
  }

  /** ZIG SIM (Core Motion attitude) sample: { t, recv, q, w, a, stickX, stickY, buttons }. */
  pushAttitude(s) {
    this.fusion.pushAttitude(s);
    this._afterSample(s);
  }

  /** ZIG SIM ARKit device pose for the same packet: { t, recv, pos, rot, att, w, fp }. */
  pushArkit(s) { this.arkit.push(s); }

  _afterSample(s) {
    this.stick.x = s.stickX; this.stick.y = s.stickY; this.buttons = s.buttons;
    if (!this.fusion.ready) return;
    const dt = this._tPrev === null ? 0 : Math.min(0.05, Math.max(0, (s.t - this._tPrev) / 1000));
    this._tPrev = s.t;
    const w = this.fusion.w.length();
    this.wSmooth += (w - this.wSmooth) * 0.3;
    this.stillTime = this.wSmooth < 0.3 ? this.stillTime + dt : 0;
    // linear acceleration -> body frame -> thrust integrator
    _v.copy(this.fusion.aE).applyQuaternion(Q_EW).applyQuaternion(this.calib.Y);
    // blade direction and angular velocity (body frame) let the integrator treat thrusts (along the
    // blade, little rotation) differently from swing arcs
    this.calib.swordQuat(this.fusion.q, _q2);
    _d.set(0, 1, 0).applyQuaternion(_q2);
    this.fusion.angVelEarth(_e).applyQuaternion(Q_EW).applyQuaternion(this.calib.Y);
    // how far the blade has turned over the last 0.3 s
    const hist = this._qHist;
    hist.push({ t: s.t, q: this.fusion.q.clone() });
    while (hist.length > 2 && s.t - hist[1].t > 300) hist.shift();
    const netRot = hist.length > 1 ? quatAngle(hist[0].q, this.fusion.q) : 0;
    // lever radius (HUD only)
    if (w > 3 && dt > 0) {
      const wd = this.fusion.wDot.length();
      const r = this.fusion.aE.length() / Math.sqrt(w ** 4 + wd ** 2);
      this.leverR += (Math.min(1, r) - this.leverR) * (1 - Math.exp(-dt / 0.06));
    }
    // hand speed during this swing: integrate acceleration from the last quiet moment (|ω| < 2 for
    // 50 ms) and keep the peak. Short windows, reset every pause, so drift never builds up.
    this._quiet = w < 2 ? (this._quiet || 0) + dt : 0;
    if (this._quiet > 0.05) { this._swingV.set(0, 0, 0); this.handPeak = 0; }
    else {
      this._swingV.addScaledVector(this.fusion.aE, dt);
      this.handPeak = Math.max(this.handPeak, this._swingV.length());
    }
    const p = this.params;
    this.involvement = p.involve ? Math.max(0, Math.min(1, (this.handPeak - p.vWrist) / (p.vArm - p.vWrist))) : 1;
    if (p.handModel === 'fused') this.arm.fuse(_v, w, dt, _d, _e, this.involvement, _x.set(1, 0, 0).applyQuaternion(_q2));
    else this.arm.integrate(_v, w, dt, p.bladeGate ? _d : null, _e, netRot);
  }

  /** Current (unpredicted) device attitude averaged over nothing — for calibration captures. */
  deviceQuat(out) { return out.copy(this.fusion.q); }

  /** Sword attitude in body frame from a device attitude. */
  swordQuat(qDev, out) { return this.calib.swordQuat(qDev, out); }

  /**
   * Target at pc time t (ms), body frame.
   * out: { pos: Vector3, quat: Quaternion, w: Vector3, v: Vector3, dir: Vector3 }
   */
  target(t, out) {
    this.fusion.poseAt(t, _qDev);
    this.fusion.angVelEarth(_v);
    const p = this.params;
    const dt = this._qf ? Math.min(0.05, Math.max(0, (t - this._tf) / 1000)) : 0;
    this._tf = t;
    if (!this._qf || p.smoothMinHz >= 60 || quatAngle(this._qf, _qDev) > 0.6) {
      this._qf = (this._qf || new Quaternion()).copy(_qDev); // first sample, filter off, or a re-sync jump
      this._wf.copy(_v);
    } else if (dt > 0) {
      const fc = p.smoothMinHz + p.smoothBeta * this.fusion.w.length();
      const a = 1 / (1 + 1 / (2 * Math.PI * fc * dt));
      this._qf.slerp(_qDev, a);
      this._wf.lerp(_v, a);
    }
    this.calib.swordQuat(this._qf, out.quat);
    out.dir.set(0, 1, 0).applyQuaternion(out.quat);
    _x.set(1, 0, 0).applyQuaternion(out.quat); // edge
    // guard layer (crown/side/hanging hand places) only while an attack is coming, faded in and out
    // swing-speed gate for the block/guard layers: lenient while an attack is coming (a parry snap keeps
    // the block), strict without one (blockAlways: held or slow only)
    // block assists off while ARKit (ZIG SIM) supplies the real hand position
    this.assistsOff = !p.assistWithArkit && !!this.arkit.anchor && t - this.arkit.recv < 500;
    const bHint = this.assistsOff ? null : this.blockHint, bAlways = !this.assistsOff && p.blockAlways;
    const bw0 = bHint ? p.blockW0 : p.blockIdleW0, bw1 = bHint ? p.blockW1 : p.blockIdleW1;
    const gs = Math.max(0, Math.min(1, (this.fusion.w.length() - bw0) / (bw1 - bw0)));
    const swingOff = 1 - gs * gs * (3 - 2 * gs);
    const gOn = (bHint || bAlways ? 1 : 0) * (bHint ? 1 : swingOff);
    this._guardOn = dt > 0 ? this._guardOn + (gOn - this._guardOn) * (1 - Math.exp(-dt / (gOn > this._guardOn ? 0.12 : 0.05))) : gOn;
    this.arm.guardOn = this._guardOn;
    this.arm.grip(out.dir, _h, _x); // where the arm model puts the hand for this blade (and edge)
    // angular velocity, body frame
    out.w.copy(this._wf).applyQuaternion(Q_EW).applyQuaternion(this.calib.Y);
    // the pose only moves as fast as the prediction still advances (late data: slows, then holds)
    const adv = this.fusion.advance;
    if (adv < 1) out.w.multiplyScalar(adv);
    // arm-model hand velocity along the current rotation
    const eps = 0.004;
    _d.crossVectors(out.w, out.dir).multiplyScalar(eps).add(out.dir).normalize();
    _xe.crossVectors(out.w, _x).multiplyScalar(eps).add(_x).normalize();
    this.arm.grip(_d, _g, _xe);
    _g.sub(_h).multiplyScalar(1 / eps);
    // block placement while an attack is coming (blockHint from the game: { y, side })
    const hint = bHint;
    // 1) block poses: the sword held like one of the recorded blocks -> that block's place
    let wPose = this.arm.blockGrip(out.dir, _x, this._blk);
    // 2) side blocks by intent, not an exact pose: blade leaning out toward the attack, or the edge turned
    //    to face it -> hands out on that side. (A right-hander hardly moves the arm out on the right: the
    //    blade just tilts out, or the wrist turns the edge — tools/block-events.mjs, 2026-10-15.)
    if (hint && hint.side && p.blockSide > 0) {
      const s = hint.side;
      const face = smooth01((_x.x * s - 0.45) / 0.35) * (1 - smooth01((Math.abs(_x.y) - 0.55) / 0.25));
      const lean = smooth01((out.dir.x * s - 0.15) / 0.25) * smooth01((out.dir.y - 0.2) / 0.3);
      const commit = Math.max(face, lean) * p.blockSide;
      if (commit > 0) {
        _sp.set(s * p.blockSideX, 1.15, -0.38);
        if (wPose > 0) this._blk.multiplyScalar(wPose).addScaledVector(_sp, commit).multiplyScalar(1 / (wPose + commit));
        else this._blk.copy(_sp);
        wPose = Math.max(wPose, commit);
      }
    }
    if (wPose > 0 && hint && p.blockAssist > 0) {
      // where along the blade (strong half: 0.15–0.45 m from the grip) it should cross the attack height
      const dy = out.dir.y;
      const s = Math.abs(dy) > 0.05 ? Math.max(0.15, Math.min(0.45, (hint.y - this._blk.y) / dy)) : 0;
      const shift = hint.y - (this._blk.y + s * dy);
      this._blk.y += Math.max(-p.blockAssistMax, Math.min(p.blockAssistMax, shift)) * p.blockAssist;
    }
    const threat = hint || bAlways ? 1 : 0;
    const wTgt = wPose * swingOff * threat;
    const wPrev = this.blockW;
    if (dt > 0) this.blockW += (wTgt - this.blockW) * (1 - Math.exp(-dt / (wTgt > this.blockW ? p.blockRise : p.blockFall)));
    else this.blockW = wTgt;
    // swing mode (fast rotation): the hand follows the arm model only as much as the arm is involved;
    // slow mode: it follows fully and settles onto the arm-model position
    if (p.handModel === 'fused') {
      // the fused hand model already corrects the arm model with the measured hand velocity
      out.pos.copy(_h);
      out.v.copy(_g).addScaledVector(this.arm.vel, adv);
      return this._arkitBlend(this._blockOverlay(out, wPrev, dt), t, dt);
    }
    const g = Math.max(0, Math.min(1, (this.fusion.w.length() - p.swingW0) / (p.swingW1 - p.swingW0)));
    const fast = g * g * (3 - 2 * g);
    const follow = 1 - fast + fast * this.involvement;
    if (!this._hand) { this._hand = _h.clone(); this._armPrev.copy(_h); }
    this._hand.addScaledVector(_e.subVectors(_h, this._armPrev), follow);
    this._armPrev.copy(_h);
    const settle = (1 - fast) / p.settleTau; // 1/s
    _e.subVectors(_h, this._hand);
    if (dt > 0) this._hand.addScaledVector(_e, 1 - Math.exp(-dt * settle));
    out.pos.copy(this._hand);
    out.v.copy(_g).multiplyScalar(follow).addScaledVector(_e, settle).addScaledVector(this.arm.vel, adv);
    return this._arkitBlend(this._blockOverlay(out, wPrev, dt), t, dt);
  }

  /** ARKit hand position (when ZIG SIM sends it and it can be trusted) on top of everything else. */
  _arkitBlend(out, t, dt) {
    if (!this.arkit.has) return out;
    this.arkit.update(t, dt, this.calib.Y, out.pos, out.dir, out.quat, this._arkOff, this._arkRate);
    out.pos.add(this._arkOff);
    out.v.add(this._arkRate);
    return out;
  }

  /** Blend the hand toward the block-pose place by the block weight (velocity includes the blend). */
  _blockOverlay(out, wPrev, dt) {
    const w = this.blockW;
    if (w < 1e-3 && wPrev < 1e-3) return out;
    _e.subVectors(this._blk, out.pos);
    out.pos.addScaledVector(_e, w);
    out.v.multiplyScalar(1 - w);
    if (dt > 0) out.v.addScaledVector(_e, (w - wPrev) / dt);
    return out;
  }
}
