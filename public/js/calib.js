// Grip / heading calibration: maps the phone's attitude to the sword's attitude.
//
//   swordWorld = Y · Q_EW · qDev · G
//     G : sword frame -> device frame (how the phone sits in the hand), solved from two poses
//     Y : yaw about world +Y so that "pointing at the screen" is world -Z
import { Quaternion, Vector3 } from 'three';
import { Q_EW, quatFromBasis, yawQuat } from './orient.js';

const UP_E = new Vector3(0, 0, 1);
const DOWN_E = new Vector3(0, 0, -1);
const _q = new Quaternion();
const _v = new Vector3();

// Default grip: portrait, top of phone toward the tip, screen facing the thumb side
// (left, for a right hand pointing forward with knuckles up). Sword x = -device x,
// sword y = device y, sword z = -device z  ->  180° about device y.
export const DEFAULT_GRIP = new Quaternion(0, 1, 0, 0);

export class Calibration {
  constructor() {
    this.G = DEFAULT_GRIP.clone();
    this.yaw = 0;
    this.Y = new Quaternion();
    this.gripCalibrated = false;
    this.headingCalibrated = false;
  }

  setYaw(a) { this.yaw = a; yawQuat(a, this.Y); }

  /** Sword orientation in the player's body frame (before body yaw). */
  swordQuat(qDev, out = new Quaternion()) {
    return out.copy(this.Y).multiply(Q_EW).multiply(qDev).multiply(this.G);
  }

  /** Heading that maps the blade's horizontal direction at qDev to world -Z. null if blade is too vertical. */
  headingFor(qDev, G = this.G) {
    _q.copy(Q_EW).multiply(qDev).multiply(G);
    const f = _v.set(0, 1, 0).applyQuaternion(_q);
    if (Math.abs(f.y) > 0.85) return null;
    return Math.PI - Math.atan2(f.x, f.z);
  }

  /** Quick re-center: keep the grip, fix only the heading. Returns false if the blade isn't pointed forward-ish. */
  recenter(qDev) {
    const h = this.headingFor(qDev);
    if (h === null) return false;
    this.setYaw(h);
    this.headingCalibrated = true;
    return true;
  }

  /**
   * Solve grip + heading from:
   *   qUp  : blade held vertical, tip up
   *   qFwd : blade pointed at the screen, horizontal, knuckles up (true edge down)
   */
  static solve(qUp, qFwd) {
    const b = UP_E.clone().applyQuaternion(qUp.clone().invert()).normalize();     // blade axis, device frame
    const down = DOWN_E.clone().applyQuaternion(qFwd.clone().invert()).normalize(); // down at fwd pose, device frame
    const dot = b.dot(down);
    const warnings = [];
    if (Math.abs(dot) > 0.6) warnings.push('forward-not-horizontal');
    const e = down.clone().addScaledVector(b, -dot);
    if (e.lengthSq() < 1e-4) return { ok: false, warnings: ['degenerate'] };
    e.normalize();
    const n = new Vector3().crossVectors(e, b);
    const G = quatFromBasis(e, b, n);
    // heading from the forward pose
    const f = new Vector3(0, 1, 0).applyQuaternion(Q_EW.clone().multiply(qFwd).multiply(G));
    const yaw = Math.PI - Math.atan2(f.x, f.z);
    return { ok: true, G, yaw, warnings, tilt: Math.asin(Math.max(-1, Math.min(1, -dot))) };
  }

  /**
   * Least-squares grip + heading from several mimicked poses.
   *   pairs: [{ q: device attitude, S: target sword attitude (body frame) }]
   *   init : { G, yaw } starting guess (e.g. from solve())
   * Blade direction errors weigh most; edge (roll) errors less, since people copy roll loosely.
   * Returns { G, yaw, residuals: [deg per pose], rms, dropped: [indices] }.
   */
  static solveMulti(pairs, init, { edgeWeight = 0.35, outlierDeg = 20 } = {}) {
    const Yq = new Quaternion(), M = new Quaternion(), R = new Quaternion();
    const ub = new Vector3(), ue = new Vector3(), vb = new Vector3(), ve = new Vector3(), corr = new Vector3(), tmp = new Vector3();
    const Y_AX = new Vector3(0, 1, 0), X_AX = new Vector3(1, 0, 0);
    const run = (set, G0, yaw0) => {
      const G = G0.clone();
      let yaw = yaw0;
      for (let it = 0; it < 60; it++) {
        yawQuat(yaw, Yq);
        // grip: rotate G so its blade/edge axes agree with the targets seen in device frame
        for (let k = 0; k < 3; k++) {
          corr.set(0, 0, 0);
          let wsum = 0;
          for (const p of set) {
            M.copy(Yq).multiply(Q_EW).multiply(p.q).invert();
            vb.copy(Y_AX).applyQuaternion(p.S).applyQuaternion(M);
            ve.copy(X_AX).applyQuaternion(p.S).applyQuaternion(M);
            ub.copy(Y_AX).applyQuaternion(G);
            ue.copy(X_AX).applyQuaternion(G);
            corr.add(tmp.crossVectors(ub, vb)).addScaledVector(tmp.crossVectors(ue, ve), edgeWeight);
            wsum += 1 + edgeWeight;
          }
          corr.multiplyScalar(1 / wsum);
          const a = corr.length();
          if (a < 1e-9) break;
          R.setFromAxisAngle(corr.clone().normalize(), Math.asin(Math.min(1, a)));
          G.premultiply(R).normalize();
        }
        // heading: weighted circular mean of horizontal angle differences
        let sn = 0, cs = 0;
        for (const p of set) {
          for (const [ax, w] of [[Y_AX, 1], [X_AX, edgeWeight]]) {
            const pred = tmp.copy(ax).applyQuaternion(G).applyQuaternion(p.q).applyQuaternion(Q_EW);
            const px = pred.x, pz = pred.z;
            const t = vb.copy(ax).applyQuaternion(p.S);
            const hw = Math.hypot(px, pz) * Math.hypot(t.x, t.z) * w;
            if (hw < 1e-6) continue;
            const d = Math.atan2(t.x, t.z) - Math.atan2(px, pz);
            sn += hw * Math.sin(d); cs += hw * Math.cos(d);
          }
        }
        if (sn * sn + cs * cs > 1e-12) yaw = Math.atan2(sn, cs);
      }
      yawQuat(yaw, Yq);
      const residuals = set.map((p) => {
        const pred = tmp.copy(Y_AX).applyQuaternion(G).applyQuaternion(p.q).applyQuaternion(Q_EW).applyQuaternion(Yq);
        return (pred.angleTo(vb.copy(Y_AX).applyQuaternion(p.S)) * 180) / Math.PI;
      });
      const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);
      return { G, yaw, residuals, rms };
    };
    let idx = pairs.map((_, i) => i);
    let sol = run(pairs, init.G, init.yaw);
    const dropped = [];
    // drop up to two clearly inconsistent poses (a pose the player didn't really copy)
    for (let k = 0; k < 2 && idx.length > 4; k++) {
      let worst = 0;
      sol.residuals.forEach((r, i) => { if (r > sol.residuals[worst]) worst = i; });
      if (sol.residuals[worst] < outlierDeg) break;
      dropped.push(idx[worst]);
      idx = idx.filter((_, i) => i !== worst);
      sol = run(idx.map((i) => pairs[i]), sol.G, sol.yaw);
    }
    const all = pairs.map((p) => {
      const pred = new Vector3(0, 1, 0).applyQuaternion(sol.G).applyQuaternion(p.q).applyQuaternion(Q_EW).applyQuaternion(yawQuat(sol.yaw));
      return (pred.angleTo(new Vector3(0, 1, 0).applyQuaternion(p.S)) * 180) / Math.PI;
    });
    return { ok: true, G: sol.G, yaw: sol.yaw, residuals: all, rms: sol.rms, dropped };
  }

  apply(sol) {
    this.G.copy(sol.G);
    this.setYaw(sol.yaw);
    this.gripCalibrated = true;
    this.headingCalibrated = true;
  }

  toJSON() { return { G: this.G.toArray(), yaw: this.yaw, grip: this.gripCalibrated }; }
  fromJSON(o) {
    if (!o || !o.G) return;
    this.G.fromArray(o.G);
    this.setYaw(o.yaw || 0);
    this.gripCalibrated = !!o.grip;
    this.headingCalibrated = false; // iOS yaw reference changes per page load
  }
}
