// Drives the physical sword toward the controller target with a force-limited velocity servo.
// The sword is a real dynamic body: it gets blocked, deflected and slowed by what it hits,
// and the limits on force/torque are the player's "strength" (what makes it feel heavy).
import { Vector3, Quaternion } from 'three';
import { logRot } from './orient.js';

const _q = new Quaternion();
const _e = new Vector3();
const _w = new Vector3();
const _wDes = new Vector3();
const _J = new Vector3();
const _v = new Vector3();
const _vDes = new Vector3();
const _com = new Vector3();
const _grip = new Vector3();
const _r = new Vector3();
const _tmp = new Vector3();

function mulSdp(m, v, out) {
  // Rapier SdpMatrix3: upper triangle row-major [m11, m12, m13, m22, m23, m33]
  const e = m.elements;
  const x = e[0] * v.x + e[1] * v.y + e[2] * v.z;
  const y = e[1] * v.x + e[3] * v.y + e[4] * v.z;
  const z = e[2] * v.x + e[4] * v.y + e[5] * v.z;
  return out.set(x, y, z);
}

export class SwordController {
  constructor(RAPIER, world, body) {
    this.R = RAPIER;
    this.world = world;
    this.body = body;
    this.params = {
      kLin: 38,          // 1/s  position error -> velocity
      kAng: 50,          // 1/s  orientation error -> angular velocity
      ffLin: 1.0,        // velocity feedforward
      ffAng: 1.0,
      maxForce: 500,     // N   (arm strength at the grip)
      maxTorque: 220,    // N·m (wrist + arm torque) — lower = heavier, laggier sword
      maxAngVel: 45,     // rad/s
      maxCorrW: 9,       // rad/s: cap on catch-up spin (prevents whip overshoot after a lag)
      maxCorrV: 3,       // m/s:   cap on catch-up speed of the grip
      rescueDist: 0.65,  // m: teleport if stuck this far from the target for rescueTime
      rescueTime: 0.5,
    };
    this.target = { pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3() };
    this.err = { pos: 0, angDeg: 0 };
    this.saturation = 0;   // 0..1, how hard we are pushing against the limits
    this._stuck = 0;
    this._inertia = null;
    this._invInertia = null;
  }

  teleport(pos, quat) {
    const b = this.body;
    b.setTranslation(pos, true);
    b.setRotation(quat, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  step(h, gravityY) {
    const b = this.body, p = this.params, T = this.target;
    const r = b.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    const av = b.angvel(); _w.set(av.x, av.y, av.z);
    const lv = b.linvel(); _v.set(lv.x, lv.y, lv.z);
    const c = b.worldCom(); _com.set(c.x, c.y, c.z);
    const tr = b.translation(); _grip.set(tr.x, tr.y, tr.z);

    // ---- angular servo
    const qe = T.quat.clone().multiply(_q.clone().invert());
    logRot(qe, _e);
    this.err.angDeg = (_e.length() * 180) / Math.PI;
    _tmp.copy(_e).multiplyScalar(p.kAng);
    if (_tmp.length() > p.maxCorrW) _tmp.setLength(p.maxCorrW);
    _wDes.copy(T.w).multiplyScalar(p.ffAng).add(_tmp);
    if (_wDes.length() > p.maxAngVel) _wDes.setLength(p.maxAngVel);
    this._inertia = b.effectiveAngularInertia(this._inertia || undefined);
    mulSdp(this._inertia, _tmp.subVectors(_wDes, _w), _J);
    const tLim = p.maxTorque * h;
    let sat = 0;
    if (_J.length() > tLim) { sat = Math.max(sat, _J.length() / tLim - 1); _J.setLength(tLim); }
    b.applyTorqueImpulse({ x: _J.x, y: _J.y, z: _J.z }, true);
    this._invInertia = b.effectiveWorldInvInertia(this._invInertia || undefined);
    const wNew = _w.clone().add(mulSdp(this._invInertia, _J, _tmp));

    // ---- linear servo on the grip point
    const ePos = _tmp.subVectors(T.pos, _grip);
    this.err.pos = ePos.length();
    ePos.multiplyScalar(p.kLin);
    if (ePos.length() > p.maxCorrV) ePos.setLength(p.maxCorrV);
    _vDes.copy(T.v).multiplyScalar(p.ffLin).add(ePos);
    // v_com = v_grip + w × (com - grip)
    _r.subVectors(_com, _grip);
    _vDes.add(new Vector3().crossVectors(wNew, _r));
    const m = b.mass();
    _J.subVectors(_vDes, _v).multiplyScalar(m);
    _J.y -= m * gravityY * h; // cancel this step's gravity
    const fLim = p.maxForce * h;
    if (_J.length() > fLim) { sat = Math.max(sat, _J.length() / fLim - 1); _J.setLength(fLim); }
    b.applyImpulse({ x: _J.x, y: _J.y, z: _J.z }, true);
    this.saturation += (Math.min(1, sat) - this.saturation) * 0.05;

    // ---- rescue if wedged somewhere
    if (this.err.pos > p.rescueDist) this._stuck += h; else this._stuck = 0;
    if (this._stuck > p.rescueTime) { this.teleport(T.pos, T.quat); this._stuck = 0; return true; }
    return false;
  }
}
