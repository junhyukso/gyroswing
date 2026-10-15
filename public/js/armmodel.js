// Arm model: the phone tells us only where the blade points, so the hand position is inferred.
//
// 1. Key stances: each has a designer-chosen grip position (body frame) and a blade direction.
//    Calibration asks the player to take each stance and records *their* blade direction, so the
//    mapping follows how this player actually holds the sword.
// 2. At runtime the grip is an RBF blend of the stances, weighted by blade-direction similarity.
// 3. Translation the gyro can't see (thrusts, pulls) comes from the accelerometer: leaky double
//    integration, gated off during fast rotation where centripetal acceleration dominates.
//
// Body frame: origin at the feet, y up, facing -z.
import { Vector3 } from 'three';

const v3 = (x, y, z) => new Vector3(x, y, z);
const dir = (x, y, z) => new Vector3(x, y, z).normalize();

export const STANCES = [
  { id: 'mid',       name: '중단 겨눔',       grip: v3(0.04, 1.10, -0.42), dir: dir(0, 0.35, -1) },
  { id: 'up',        name: '세워 들기',       grip: v3(0.04, 1.22, -0.32), dir: dir(0, 1, -0.1) },
  { id: 'high',      name: '상단 (머리 위)',  grip: v3(0.06, 1.78, -0.12), dir: dir(0, 0.6, 1) },
  { id: 'back',      name: '등 뒤로 넘김',    grip: v3(0.05, 1.72, 0.02),  dir: dir(0, -0.6, 1) },
  { id: 'rshoulder', name: '오른 어깨 메기',  grip: v3(0.24, 1.42, -0.12), dir: dir(0.2, 1, 0.8) },
  { id: 'lshoulder', name: '왼 어깨 메기',    grip: v3(-0.18, 1.40, -0.15), dir: dir(-0.2, 1, 0.8) },
  { id: 'right',     name: '오른쪽 수평',     grip: v3(0.38, 1.18, -0.22), dir: dir(1, 0.15, 0.25) },
  { id: 'left',      name: '왼쪽 수평',       grip: v3(-0.30, 1.12, -0.32), dir: dir(-1, 0.05, -0.35) },
  { id: 'low',       name: '하단',            grip: v3(0.04, 0.95, -0.38), dir: dir(0, -0.7, -0.7) },
  { id: 'lowleft',   name: '왼쪽 아래',       grip: v3(-0.22, 0.98, -0.30), dir: dir(-0.65, -0.55, -0.5) },
  { id: 'lowright',  name: '오른쪽 아래 뒤',  grip: v3(0.30, 0.95, -0.15), dir: dir(0.5, -0.6, 0.6) },
];

export const CHEST = new Vector3(0, 1.36, -0.04);

// Block poses read from the user's real block-drill recording (tools/blocks.mjs, 2026-10-15): to block,
// the whole arm goes out toward the attack and the edge faces it — something the blade direction
// alone can't say (a blade pointing left across the body is a block on the RIGHT). When the sword is
// held in one of these orientations (blade AND edge), the hands go to that block's place.
//   dir/edge: body frame (forward -z), hand: grip position (body frame, m)
export const BLOCK_POSES = [
  // attack from the left (head or body): blade up and leaning forward, edge to the left
  { id: 'left', dir: [-0.17, 0.75, -0.64], edge: [-0.9, 0.1, 0.4], hand: [-0.34, 1.2, -0.38] },
  // attack from the right: blade across the body pointing up-left, edge up-right; higher for head cuts
  { id: 'rightHigh', dir: [-0.75, 0.35, -0.53], edge: [0.58, 0.71, -0.36], hand: [0.3, 1.32, -0.38] },
  { id: 'rightLow', dir: [-0.69, 0.45, -0.55], edge: [0.71, 0.42, -0.55], hand: [0.3, 1.14, -0.38] },
  // overhead: blade level pointing left-forward, edge up — hands above the forehead
  { id: 'crown', dir: [-0.79, -0.04, -0.61], edge: [0.15, 0.95, -0.23], hand: [0.14, 1.72, -0.32] },
  // thrust: blade level across the front, edge forward-right
  { id: 'cross', dir: [-0.72, 0.08, -0.69], edge: [0.67, -0.2, -0.72], hand: [0.18, 1.12, -0.38] },
];

const _a = new Vector3();
const _fb = new Vector3();
const _fd = new Vector3();
const _fv = new Vector3();
const _fw = new Vector3();
const _gh = new Vector3();
const _fe = new Vector3();
const _t = new Vector3();
const _bs = new Vector3();
const _bh = new Vector3();

export class ArmModel {
  constructor() {
    this.params = {
      sigma: 0.6,        // rad, stance blend width
      thrustGain: 1.35,  // 1 = physically true displacement; 1.35 felt best on the iPhone (user, 2026-10-15)
      deadzone: 0.6,     // m/s^2 (hand at rest reads ~0.7 m/s^2 p50 on a real iPhone)
      gateW0: 1.0,       // rad/s: full integration below this (thrusts and side steps barely rotate)
      gateW1: 3.0,       // rad/s: none above — rotating arms accelerate the phone too, and the arm
                         //   model already moves the hand for that (real-iPhone tuning, tools/sweep-arm.mjs)
      stillAcc: 1.0,     // m/s^2 } below both for zuptTime = the hand has stopped:
      stillW: 1.0,       // rad/s } velocity is reset (zero-velocity update)
      zuptTime: 0.05,    // s
      tauV: 1.5,         // s, weak velocity leak while moving (bounds drift on long moves)
      tauX: 0.6,         // s, drift back to the arm-model hand position once the hand stops
      holdTime: 1.5,     // s, a stopped hand keeps its place this long first (thrust and hold) —
                         //   a still hand adds no integration error, only moves do
      alwaysDecay: false, // also drift back while moving (safer, weaker thrusts)
      // along the blade (thrusts) a little wrist rotation is normal, so that component stays open longer;
      // across the blade is where swing arcs accelerate the phone
      bladeW0: 5.0,      // tuned on real thrust + swing recordings (tools/eval-thrust.mjs)
      bladeW1: 8.0,
      leverR: 0.0,       // m: centripetal compensation r·|ω×b|² (tested on real data: makes it worse; off)
      netRot0: 0.3,      // rad: along-blade translation fully on while the blade turned less than this
      netRot1: 0.65,     //   over the last 0.3 s, off above — a thrust keeps its line, a wind-up doesn't
      peakHold: 0.45,    // s: the along-blade gate looks at the peak |ω| over this window, so the
                         //   braking tail of a swing (|ω| falling through the gate) stays blocked
      maxOffset: 0.45,   // m
      // ---- 'fused' hand model: offset' = v_measured − v_armModel (see fuse())
      fGain: 1.35,       // exaggeration of hand motion along the blade (thrust axis); 1 = true motion
      fDeadzone: 0.4,    // m/s²
      fTauV: 1.5,        // s, velocity leak while moving (zero-velocity updates do most of the work)
      fW0: 4.0,          // rad/s: above this the 60 Hz accelerometer integral stops being trustworthy…
      fW1: 8.0,          //   …and by this speed it is fully replaced by involvement × arm-model velocity
      fAfterSwing: 1.0,  // s after a swing during which the offset settles (settleTau) instead of holding
      settleTau: 0.3,    // s
      fHold: 0.3,        // s: …judged on the peak |ω| over this window, so a swing's sharp braking
                         //   (tens of ms, missed by 60 Hz samples) is covered too
      fTauDrift: 4.0,    // s, slow pull of the offset back to the arm model while moving
      fMaxOffset: 0.6,   // m
      guardHigh: 1.0,    // weight of the overhead-block hand lift (see guardGrip)
      guardSide: 1.0,    // weight of the side-block hand shift
      blockOn: 1.0,      // block poses (BLOCK_POSES): 0 = off
      blockA0: 0.35,     // rad: full weight while the sword is within this of a block pose…
      blockA1: 0.7,      //   …none beyond this (rest guard vs. left block differ ~70° in edge alone)
      reachMax: 0.74,    // m from chest
      reachMin: 0.16,
    };
    this.stances = STANCES.map((s) => ({ ...s, grip: s.grip.clone(), dir: s.dir.clone(), calibrated: false }));
    this.setBlockPoses(BLOCK_POSES);
    // guard layer weight (0..1), set by the controller: on only while an attack is coming — swings pass
    // through crown/side-guard orientations and the layer then yanked the hands around (0.7 m spikes)
    this.guardOn = 1;
    this.offset = new Vector3();
    this.vel = new Vector3();
    this.stillT = 0;
    this.wPeak = 0;
    this.weights = new Float32Array(this.stances.length);
    this._coef = null;
  }

  invalidate() { this._coef = null; }

  stance(id) { return this.stances.find((s) => s.id === id); }

  setStanceDir(id, d) {
    const s = this.stance(id);
    if (!s) return;
    s.dir.copy(d).normalize();
    s.calibrated = true;
    this._coef = null;
  }

  resetStances() {
    this.stances.forEach((s, i) => { s.dir.copy(STANCES[i].dir); s.calibrated = false; });
    this._coef = null;
  }

  /** Normalized Gaussian basis over blade direction; fills this.weights, returns nearest index. */
  _basis(bladeDir) {
    const sig2 = this.params.sigma * this.params.sigma;
    let sum = 0, best = 0, bestDot = -2;
    for (let i = 0; i < this.stances.length; i++) {
      const d = Math.max(-1, Math.min(1, bladeDir.dot(this.stances[i].dir)));
      if (d > bestDot) { bestDot = d; best = i; }
      const ang = Math.acos(d);
      const w = Math.exp(-(ang * ang) / sig2);
      this.weights[i] = w;
      sum += w;
    }
    if (sum < 1e-9) { this.weights.fill(0); this.weights[best] = 1; return best; }
    for (let i = 0; i < this.weights.length; i++) this.weights[i] /= sum;
    return best;
  }

  /**
   * Normalized-RBF interpolation coefficients: chosen so a stance direction maps (almost) exactly
   * to its stance grip. Ridge-regularized so near-duplicate calibrated directions stay stable.
   */
  _solve() {
    const n = this.stances.length;
    const A = [];
    for (let i = 0; i < n; i++) {
      this._basis(this.stances[i].dir);
      A.push(Array.from(this.weights));
      A[i][i] += 0.01;
    }
    // interpolate offsets from the chest so the ridge term shrinks toward the chest, not the origin
    const coef = this.stances.map((s) => s.grip.clone().sub(CHEST));
    // Gaussian elimination with partial pivoting, 3 right-hand sides at once
    const B = coef.map((v) => [v.x, v.y, v.z]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
      for (let r = c + 1; r < n; r++) {
        const f = A[r][c] / A[c][c];
        for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
        for (let k = 0; k < 3; k++) B[r][k] -= f * B[c][k];
      }
    }
    for (let c = n - 1; c >= 0; c--) {
      for (let k = 0; k < 3; k++) {
        let s = B[c][k];
        for (let j = c + 1; j < n; j++) s -= A[c][j] * B[j][k];
        B[c][k] = s / A[c][c];
      }
    }
    this._coef = B.map((b) => new Vector3(b[0], b[1], b[2]));
  }

  /** Arm-model grip position (body frame) for a blade direction (body frame, unit). */
  baseGrip(bladeDir, out = new Vector3()) {
    if (!this._coef) this._solve();
    this._basis(bladeDir);
    out.copy(CHEST);
    for (let i = 0; i < this._coef.length; i++) out.addScaledVector(this._coef[i], this.weights[i]);
    return out;
  }

  /**
   * Accelerometer translation integrator. aBody: linear accel (gravity-free) in body frame.
   * wMag: angular speed (rad/s). Call once per sensor sample.
   */
  integrate(aBody, wMag, dt, bladeDir = null, wBody = null, netRot = 0) {
    const p = this.params;
    if (dt <= 0) return;
    const gateOf = (w, w0, w1) => Math.max(0, Math.min(1, 1 - (w - w0) / (w1 - w0)));
    const gate = gateOf(wMag, p.gateW0, p.gateW1);
    // peak-hold of the angular speed (decays to the current value over peakHold)
    this.wPeak = p.peakHold > 0 ? Math.max(wMag, this.wPeak * Math.exp(-dt / p.peakHold)) : wMag;
    const raw = aBody.length();
    _a.copy(aBody);
    if (bladeDir && wBody && p.leverR > 0) {
      // a hand swung on a lever of length r about a pivot behind it is pulled toward the pivot by
      // r·|ω×b|² along the blade — that's not the hand moving on its own, so put it back
      const wx = wBody.y * bladeDir.z - wBody.z * bladeDir.y, wy = wBody.z * bladeDir.x - wBody.x * bladeDir.z, wz = wBody.x * bladeDir.y - wBody.y * bladeDir.x;
      _a.addScaledVector(bladeDir, p.leverR * (wx * wx + wy * wy + wz * wz));
    }
    if (raw > p.deadzone) _a.multiplyScalar((raw - p.deadzone) / raw); else _a.set(0, 0, 0);
    let gBlade = gate;
    if (bladeDir) {
      gBlade = Math.min(gateOf(this.wPeak, p.bladeW0, p.bladeW1), gateOf(netRot, p.netRot0, p.netRot1));
      const along = _a.dot(bladeDir);
      // across-blade part gets the strict gate, along-blade part the lenient one (applied below as 1)
      _a.addScaledVector(bladeDir, -along).multiplyScalar(gate).addScaledVector(bladeDir, along * gBlade);
    }
    // zero-velocity update: once the hand has stopped, whatever velocity is left is drift
    this.stillT = raw < p.stillAcc && wMag < p.stillW ? this.stillT + dt : 0;
    if (this.stillT > p.zuptTime) this.vel.multiplyScalar(Math.exp(-dt / 0.03));
    else {
      this.vel.addScaledVector(_a, p.thrustGain * (bladeDir ? 1 : gate) * dt);
      this.vel.multiplyScalar(Math.exp(-dt / p.tauV));
      const gMax = Math.max(gate, gBlade);
      if (gMax < 1) this.vel.multiplyScalar(Math.exp((-dt * (1 - gMax)) / 0.05)); // fast swing: don't carry velocity
    }
    this.offset.addScaledVector(this.vel, dt);
    // drift back to the arm model only once the hand has stopped (or during a swing), not mid-thrust
    if (p.alwaysDecay || this.stillT > p.zuptTime + p.holdTime || Math.max(gate, gBlade) < 1) this.offset.multiplyScalar(Math.exp(-dt / p.tauX));
    if (this.offset.length() > p.maxOffset) {
      this.offset.setLength(p.maxOffset);
      this.vel.multiplyScalar(0.5);
    }
  }

  /**
   * 'Fused' hand model. The arm model is a prior for where the hand is for a blade direction; the
   * accelerometer gives the hand's real velocity (single integration, reset whenever the hand stops).
   * The offset integrates the difference, so:
   *   thrust      — blade line fixed, hand moves     -> offset grows by the real reach
   *   wrist flick — arm model moves, hand doesn't    -> offset cancels it, the hand stays put
   *   arm swing   — both move alike                  -> offset stays near zero (no double counting)
   */
  fuse(aBody, wMag, dt, bladeDir, wBody, involvement = 1, edgeDir = null) {
    const p = this.params;
    if (dt <= 0) return;
    const raw = aBody.length();
    _a.copy(aBody);
    if (raw > p.fDeadzone) _a.multiplyScalar((raw - p.fDeadzone) / raw); else _a.set(0, 0, 0);
    this.stillT = raw < p.stillAcc && wMag < p.stillW ? this.stillT + dt : 0;
    const stopped = this.stillT > p.zuptTime;
    if (!this.vMeas) this.vMeas = new Vector3();
    if (stopped) this.vMeas.multiplyScalar(Math.exp(-dt / 0.03));
    else { this.vMeas.addScaledVector(_a, dt); this.vMeas.multiplyScalar(Math.exp(-dt / p.fTauV)); }
    // hand velocity the arm model implies for the current rotation
    const eps = 0.004;
    const base = this.guardGrip(bladeDir, edgeDir, this.baseGrip(bladeDir, _fb));
    _fd.crossVectors(wBody, bladeDir).multiplyScalar(eps).add(bladeDir).normalize();
    if (edgeDir) _fe.crossVectors(wBody, edgeDir).multiplyScalar(eps).add(edgeDir).normalize();
    const vArm = this.guardGrip(_fd, edgeDir ? _fe : null, this.baseGrip(_fd, _fw)).sub(base).multiplyScalar(1 / eps);
    if (stopped) vArm.set(0, 0, 0);
    // fast rotation: a 60 Hz integral misses the sharp braking of a swing, so trust the model instead —
    // the arm model's hand velocity, scaled by how much of the arm (vs. only the wrist) is swinging
    this.fPeak = Math.max(wMag, (this.fPeak || 0) * Math.exp(-dt / p.fHold));
    const k = Math.max(0, Math.min(1, (this.fPeak - p.fW0) / (p.fW1 - p.fW0)));
    if (k > 0) this.vMeas.lerp(_fv.copy(vArm).multiplyScalar(involvement), k * k * (3 - 2 * k));
    this.vel.copy(this.vMeas).sub(vArm);
    const along = this.vel.dot(bladeDir);
    this.vel.addScaledVector(bladeDir, along * (p.fGain - 1)); // exaggerate thrusts only
    this.offset.addScaledVector(this.vel, dt);
    // after a swing the offset is the least trustworthy (the swing's involvement was only known as it
    // built up), so settle onto the arm model quickly and don't 'hold' it; thrusts keep the hold
    this.sinceSwing = k > 0 ? 0 : (this.sinceSwing ?? 9) + dt;
    let tau;
    if (k > 0) tau = Infinity;                                 // mid-swing: keep anchoring a flick
    else if (this.sinceSwing < p.fAfterSwing) tau = p.settleTau;
    else tau = this.stillT > p.zuptTime + p.holdTime ? p.tauX : stopped ? Infinity : p.fTauDrift;
    if (tau !== Infinity) this.offset.multiplyScalar(Math.exp(-dt / tau));
    if (this.offset.length() > p.fMaxOffset) this.offset.setLength(p.fMaxOffset);
  }

  /** Final grip target in body frame. */
  /**
   * Guard layer: hand positions the blade direction alone can't express, read from the edge.
   *  - crown / overhead block: blade across (pointing sideways, near level), an edge facing up ->
   *    hands up in front of the forehead, on the side opposite to where the blade points
   *  - side block: blade upright, edge facing a side -> hands move to that side
   * (with a natural grip the true edge faces the knuckles, so these follow how people block)
   */
  guardGrip(bladeDir, edgeDir, out) {
    const on = this.guardOn;
    if (!edgeDir || !(on > 0)) return out;
    const p = this.params;
    const sm = (x) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c); };
    const level = 1 - sm((Math.abs(bladeDir.y) - 0.35) / 0.25);
    const lateral = sm((Math.abs(bladeDir.x) - 0.55) / 0.3);
    const edgeUp = sm((Math.abs(edgeDir.y) - 0.5) / 0.3);
    const wHigh = level * lateral * edgeUp * p.guardHigh * on;
    if (wHigh > 0) out.lerp(_gh.set(-Math.sign(bladeDir.x) * 0.16, 1.74, -0.3), wHigh);
    const upright = sm((bladeDir.y - 0.65) / 0.25);
    out.x += upright * edgeDir.x * 0.24 * p.guardSide * on;
    // hanging block: point down, edge facing a side -> hands at chest height on that side, so the
    // blade hangs over the flank (how a body-height side cut is stopped)
    const hanging = sm((-bladeDir.y - 0.6) / 0.25) * sm((Math.abs(edgeDir.x) - 0.5) / 0.3) * p.guardSide * on;
    if (hanging > 0) out.lerp(_gh.set(Math.sign(edgeDir.x) * 0.2, 1.3, -0.3), hanging);
    return out;
  }

  setBlockPoses(list) {
    this.blockPoses = list.map((b) => {
      const dir = new Vector3(...b.dir).normalize();
      const edge = new Vector3(...b.edge);
      edge.addScaledVector(dir, -edge.dot(dir)).normalize();
      return { id: b.id, dir, edge, side: new Vector3().crossVectors(dir, edge), hand: new Vector3(...b.hand) };
    });
  }

  /**
   * Block layer: how close the sword's orientation (blade + edge) is to a block pose, and the hand
   * position for it. Writes the weighted hand into out and returns the weight (0..1).
   */
  blockGrip(bladeDir, edgeDir, out) {
    const p = this.params;
    if (!edgeDir || !p.blockOn) return 0;
    _bs.crossVectors(bladeDir, edgeDir);
    let sum = 0, best = 0;
    _bh.set(0, 0, 0);
    for (const b of this.blockPoses) {
      // rotation angle between the two sword frames: cos = (trace(R1ᵀR2) − 1) / 2
      const c = (bladeDir.dot(b.dir) + edgeDir.dot(b.edge) + _bs.dot(b.side) - 1) / 2;
      const ang = Math.acos(Math.max(-1, Math.min(1, c)));
      const x = Math.max(0, Math.min(1, (ang - p.blockA0) / (p.blockA1 - p.blockA0)));
      const w = 1 - x * x * (3 - 2 * x);
      if (w <= 0) continue;
      _bh.addScaledVector(b.hand, w);
      sum += w; best = Math.max(best, w);
    }
    // no pose near: leave out as it was (the last block place, while the weight fades out)
    if (sum > 0) out.copy(_bh).multiplyScalar(1 / sum);
    return best * p.blockOn;
  }

  grip(bladeDir, out = new Vector3(), edgeDir = null) {
    this.baseGrip(bladeDir, out);
    this.guardGrip(bladeDir, edgeDir, out).add(this.offset);
    _t.copy(out).sub(CHEST);
    const d = _t.length();
    const p = this.params;
    if (d > p.reachMax) out.copy(CHEST).addScaledVector(_t, p.reachMax / d);
    else if (d < p.reachMin) out.copy(CHEST).addScaledVector(_t, p.reachMin / Math.max(d, 1e-6));
    return out;
  }

  toJSON() {
    return this.stances.filter((s) => s.calibrated).map((s) => ({ id: s.id, dir: s.dir.toArray() }));
  }
  fromJSON(arr) {
    if (!Array.isArray(arr)) return;
    for (const o of arr) this.setStanceDir(o.id, new Vector3().fromArray(o.dir));
  }
}
