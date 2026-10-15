// Hand position from ARKit (ZIG SIM app, DEVICE tracking) — used only while it can be trusted.
//
// What a recording showed (tools/zig.mjs, 2026-10-15): held or slow, ARKit's device position is steady
// to 6–30 mm; swinging, the camera loses its features, ARKit carries on from the IMU alone and drifts
// by up to 2 m in a few seconds, then snaps back when it relocalises. So: the arm model stays in charge,
// and ARKit pulls the hand to where it really is only while the sword is slow, ARKit sees enough
// features, its motion is humanly possible, the point is within arm's reach and it hasn't just jumped.
//
// Frames (fitted, tools/zig-frames.mjs): ARKit camera orientation = W · att · C, with att the Core
// Motion attitude (device -> reference, z up) in the same packet, C the fixed camera <- device turn
// (+90° about z) and W the ARKit-world <- reference rotation (estimated live). The body frame is the
// game's: v_body = Y · Q_EW · W^-1 · v_arkit (Y = calibrated heading).
import { Quaternion, Vector3 } from 'three';
import { Q_EW } from './orient.js';
import { CHEST } from './armmodel.js';

const CAM_FROM_DEV = new Quaternion(0, 0, Math.SQRT1_2, Math.SQRT1_2); // device axis -> camera axis
const DEV_FROM_CAM = CAM_FROM_DEV.clone().invert();
const smooth = (x) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };
const _v = new Vector3(), _q = new Quaternion(), _q2 = new Quaternion();

export class ArkitHand {
  constructor() {
    this.params = {
      // camera lens -> the point the hand holds, in the phone's own frame (m): the rear camera sits at
      // the top right (seen from the screen), the hand grips the lower half
      gripOffset: [-0.023, -0.091, 0.005],
      // ARKit drifts in SUSTAINED swinging (the camera loses its features), not in a quick move into a
      // block (block drill recording: the player moves at the strike at 3–8 rad/s and the hit comes
      // 0.1–0.25 s later — ARKit has to be in by then). So: cut off by the rotation accumulated over the
      // last ~0.4 s, and only very fast instantaneous rotation
      wLo: 4.0, wHi: 8.0,          // rad/s: trusted below wLo, not at all above wHi
      swingRot: 2.2,               // rad turned within ~0.4 s = a swing: ARKit not trusted…
      swingHold: 0.35,             // s …until this long after it (tracking recovers / relocalises)
      // ARKit's drift came exactly when it saw few feature points WHILE moving (swinging past a bare
      // ceiling: 1–15 points, position ran off by metres); few points while held still was fine (LiDAR),
      // and moving with many points was fine. So few points + motion = blind for a moment.
      // But only SUSTAINED and brisk: the drift (rec 02-52) built up over 1.5–3 s of swinging at 2–8 rad/s
      // with 1–8 points, while raising the sword slowly for a high block or a cut (the camera turns to
      // the ceiling, 1–16 points for 0.3–1 s at 1–2 rad/s) ARKit held the hand fine. So low-feature
      // motion is accumulated, weighted by how brisk it is (w / blindW, speed / blindV), leaking away
      // (fast while ARKit sees well again, slowly otherwise), and counts as blind past blindAfter.
      fpMin: 12, fpSee: 25, blindMoveW: 1.5, blindMoveV: 0.4, blindAfter: 0.5, blindW: 3, blindV: 0.8, blindForget: 0.5, blindForgetDark: 1, blindHold: 0.4,
      steadyAfterBlind: 0.2,       // s held steady before trusting again after flying blind (it may have drifted)…
      seeAgain: 0.3,               // s …or seeing well (fpSee) again this long (ARKit relocalises; a jump is caught)
      vMax: 2.5,                   // m/s: faster ARKit motion than this is drift, not a hand
      reach: 0.85, reachMin: 0.15, // m from the chest (closer = inside the torso: drift)
      settle: 0.06,                // s of good samples in a row before trusting again
      jumpHold: 0.3,               // s untrusted after a relocalisation jump
      trustRise: 0.04, trustFall: 0.05, // s: start / stop listening to ARKit
      follow: 0.07, release: 0.5,  // s: hand offset toward ARKit's hand / eased back to the arm model
      // ARKit measures the phone in the ROOM; the game needs it relative to the body. A step or a lean
      // looks like a hand move, so the origin is re-tied to the arm model: quickly whenever the sword is
      // back, still, in the guard it was anchored in (the hand is surely at the guard place then),
      // slowly otherwise (body drift over seconds; a held block keeps most of its offset)
      guardDeg: 20, guardTau: 0.3, anchorTau: 10,
      wTau: 1.5,                   // s: W (world alignment) smoothing while slow
      lead: 0.05,                  // s: ARKit is ~50 ms behind the gyro; lead its motion by that
    };
    this.reset();
  }

  reset() {
    this.W = null;
    this.has = false;
    this.gripA = new Vector3();     // grip point, ARKit world
    this.velA = new Vector3();
    this.tA = 0; this.recv = 0; this.fp = 0; this.w = 0;
    this.jumpUntil = 0;
    this.rotAcc = 0;                // rad turned recently (decays over ~0.4 s)
    this.blindUntil = 0;            // ARKit flying blind (few features while moving) until then
    this.blindAcc = 0;              // s of recent low-feature motion
    this.needSteady = false;        // after flying blind: wait for a steady moment
    this.steadyFor = 0; this.seeFor = 0;
    this.swingUntil = 0;
    this._hist = [];
    this.okSince = null;
    this.anchor = null;             // body-frame offset making ARKit agree with the arm model in guard
    this.guardQ = null;             // sword orientation (body) when anchored = the player's guard
    this.yawKey = null;             // re-anchor when the heading calibration changes
    this.trust = 0;                 // 0..1
    this.D = new Vector3();         // current hand offset (ARKit hand - arm-model hand), body frame
    this.hand = new Vector3();      // ARKit hand, body frame (when valid)
    this.valid = false;
  }

  /** One ZIG SIM packet: s = { t (ms), recv (ms), pos [x,y,z], rot [x,y,z,w], att (Quaternion), w (rad/s), fp }. */
  push(s) {
    const rot = _q.set(s.rot[0], s.rot[1], s.rot[2], s.rot[3]).normalize();
    // world alignment W = rot · C^-1 · att^-1 (only while slow: ARKit's own rotation lags in swings)
    const Wm = rot.clone().multiply(CAM_FROM_DEV).multiply(_q2.copy(s.att).invert());
    if (!this.W) this.W = Wm.clone();
    else if (s.w < 1.5) this.W.slerp(Wm, 1 - Math.exp(-Math.max(0, (s.t - this.tA) / 1000) / this.params.wTau));
    // camera -> grip
    const grip = new Vector3(...this.params.gripOffset).applyQuaternion(CAM_FROM_DEV).applyQuaternion(rot).add(_v.set(s.pos[0], s.pos[1], s.pos[2]));
    if (this.has) {
      const dt = (s.t - this.tA) / 1000;
      // relocalisation: a big step at an impossible speed (with a floor on dt: bursts of late packets
      // arrive ~1 ms apart)
      if (dt >= 0 && grip.distanceTo(this.gripA) > 0.06 && grip.distanceTo(this.gripA) / Math.max(dt, 0.016) > 6) this.jumpUntil = s.recv + this.params.jumpHold * 1000;
    }
    // velocity over ~0.1 s (packet timing jitters; per-step differences spike)
    this._hist.push({ t: s.t, p: grip.clone() });
    while (this._hist.length > 2 && s.t - this._hist[1].t > 100) this._hist.shift();
    const h0 = this._hist[0];
    if (s.t - h0.t > 30) this.velA.subVectors(grip, h0.p).multiplyScalar(1000 / (s.t - h0.t));
    this.gripA.copy(grip);
    this.tA = s.t; this.recv = s.recv; this.fp = s.fp; this.w = s.w;
    this.has = true;
  }

  /** ARKit-world vector -> body frame. */
  _toBody(vA, Y, out) {
    return out.copy(vA).applyQuaternion(_q.copy(this.W).invert()).applyQuaternion(Q_EW).applyQuaternion(Y);
  }

  /**
   * Per target frame: blend the arm-model hand toward ARKit's. now/dt on the receive clock (ms / s).
   * modelHand, bladeDir, swordQ: body frame. Returns the hand offset to add (body frame) and its rate of change.
   */
  update(now, dt, Y, modelHand, bladeDir, swordQ, outOffset, outRate) {
    const p = this.params;
    // swinging: rotation accumulated over the last ~0.4 s
    if (dt > 0) this.rotAcc = this.rotAcc * Math.exp(-dt / 0.4) + this.w * dt;
    if (this.rotAcc > p.swingRot) this.swingUntil = now + p.swingHold * 1000;
    this.valid = false;
    let target = 0;
    if (this.has && this.W && now - this.recv < 200) {
      const yawKey = Y.toArray().map((x) => x.toFixed(4)).join();
      if (yawKey !== this.yawKey) { this.yawKey = yawKey; this.anchor = null; }   // heading recalibrated
      this._toBody(this.gripA, Y, this.hand);
      _v.copy(this._toBody(this.velA, Y, new Vector3())).multiplyScalar(p.lead);
      this.hand.add(_v);
      const speed = this.velA.length();
      const still = this.w < 0.6 && speed < 0.3;
      // anchor: ARKit's origin is wherever its session started — tie it to the arm model the first time
      // the sword is held still in front (the guard), and remember that guard
      const front = bladeDir.y > 0.2 && bladeDir.z < -0.3 && Math.abs(bladeDir.x) < 0.4;
      if (!this.anchor && front && still && now > this.jumpUntil) {
        this.anchor = new Vector3().subVectors(modelHand, this.hand);
        this.guardQ = swordQ.clone();
      }
      if (this.anchor) {
        this.hand.add(this.anchor);
        // (feature points are NOT required: with LiDAR, ARKit held a steady position looking at a bare
        // ceiling with 1–8 points; drift shows up as speed, jumps and leaving arm's reach instead)
        const reach = this.hand.distanceTo(CHEST);
        const ok = speed < p.vMax && now > this.jumpUntil && reach < p.reach && reach > p.reachMin;
        if (ok) { if (this.okSince === null) this.okSince = now; } else this.okSince = null;
        const settled = this.okSince !== null && now - this.okSince > p.settle * 1000;
        const lowMove = this.fp < p.fpMin && (this.w > p.blindMoveW || speed > p.blindMoveV);
        if (lowMove) this.blindAcc += dt * Math.min(2, Math.max(0.3, this.w / p.blindW, speed / p.blindV));
        else this.blindAcc *= Math.exp(-dt / (this.fp >= p.fpSee ? p.blindForget : p.blindForgetDark));
        if (lowMove && this.blindAcc > p.blindAfter) { this.blindUntil = now + p.blindHold * 1000; this.needSteady = true; }
        this.steadyFor = this.w < 1.0 && speed < 0.3 ? this.steadyFor + dt : 0;
        this.seeFor = this.fp >= p.fpSee ? this.seeFor + dt : 0;
        if (this.needSteady && now > this.blindUntil && (this.steadyFor > p.steadyAfterBlind || this.seeFor > p.seeAgain)) this.needSteady = false;
        target = settled && now > this.swingUntil && now > this.blindUntil && !this.needSteady ? 1 - smooth((this.w - p.wLo) / (p.wHi - p.wLo)) : 0;
        this.valid = ok;
        // re-tie the origin to the body (see params). In the guard (the whole sword orientation, edge
        // included, back within guardDeg of the anchoring one — a wrist-turned block with the blade
        // in the same place doesn't count) the arm model is the reference: ARKit adds nothing there.
        this.inGuard = this.w < 0.8 && this.guardQ && swordQ.angleTo(this.guardQ) < (p.guardDeg * Math.PI) / 180;
        if (this.inGuard) target = 0;
        if (ok && dt > 0) {
          const tau = this.inGuard ? p.guardTau : p.anchorTau;
          const k = 1 - Math.exp(-dt / tau);
          _v.subVectors(modelHand, this.hand);
          this.anchor.addScaledVector(_v, k);
          this.hand.addScaledVector(_v, k);
        }
      }
    } else this.okSince = null;
    if (dt > 0) this.trust += (target - this.trust) * (1 - Math.exp(-dt / (target > this.trust ? p.trustRise : p.trustFall)));
    else this.trust = target;
    // the hand offset follows ARKit's hand while it's trusted; when not (a swing starting, tracking lost,
    // back in the guard) it's eased back to the arm model — a swing from a side block starts where the
    // hand really is, then rejoins the arm model
    const listening = this.valid && this.anchor && this.trust > 0.5;
    const goal = listening ? _v.subVectors(this.hand, modelHand) : _v.set(0, 0, 0);
    const prev = outRate.copy(this.D);
    if (dt > 0) this.D.addScaledVector(goal.sub(this.D), 1 - Math.exp(-dt / (listening ? p.follow : p.release)));
    outRate.subVectors(this.D, prev).multiplyScalar(dt > 0 ? 1 / dt : 0);
    return outOffset.copy(this.D);
  }
}
