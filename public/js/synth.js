// Synthesizes phone samples exactly as iOS Safari would report them.
// Used by the in-game simulator (no phone) and by node tests.
import { Quaternion, Vector3 } from 'three';
import { quatToEuler } from './orient.js';

const R2D = 180 / Math.PI;
const G = 9.81;

/**
 * qDev   : true device attitude D->E
 * wDev   : true angular velocity, device frame, rad/s
 * aEarth : true linear acceleration (gravity-free), earth frame, m/s^2
 * opts   : { gyroNoise (rad/s), accNoise, oriNoiseDeg, rawMap(fn) }
 */
export function synthSample(t, qDev, wDev, aEarth, opts = {}) {
  const e = quatToEuler(qDev);
  const n = (s) => (s ? (Math.random() * 2 - 1) * s : 0);
  const on = opts.oriNoiseDeg || 0;
  const qi = qDev.clone().invert();
  const aDev = aEarth.clone().applyQuaternion(qi);
  const gDev = new Vector3(0, 0, G).applyQuaternion(qi); // spec: reads +g "up" when at rest
  const gs = opts.gravitySign ?? 1;
  let rr = { a: (wDev.z + n(opts.gyroNoise)) * R2D, b: (wDev.x + n(opts.gyroNoise)) * R2D, g: (wDev.y + n(opts.gyroNoise)) * R2D };
  if (opts.rawMap) rr = opts.rawMap(rr);
  return {
    t,
    flags: 3,
    alpha: e.alpha + n(on), beta: e.beta + n(on), gamma: e.gamma + n(on),
    rrA: rr.a, rrB: rr.b, rrG: rr.g,
    ax: gs * (aDev.x + n(opts.accNoise)), ay: gs * (aDev.y + n(opts.accNoise)), az: gs * (aDev.z + n(opts.accNoise)),
    gx: gs * (aDev.x + gDev.x), gy: gs * (aDev.y + gDev.y), gz: gs * (aDev.z + gDev.z),
    interval: 16.67,
    oriAge: 0,
    stickX: 0, stickY: 0, buttons: 0,
  };
}

/** Body-frame angular velocity from two attitudes dt apart. */
export function bodyRate(q0, q1, dt, out = new Vector3()) {
  const d = q0.clone().invert().multiply(q1);
  if (d.w < 0) { d.x = -d.x; d.y = -d.y; d.z = -d.z; d.w = -d.w; }
  const s = Math.hypot(d.x, d.y, d.z);
  if (s < 1e-9) return out.set(0, 0, 0);
  const ang = 2 * Math.atan2(s, d.w);
  return out.set(d.x / s, d.y / s, d.z / s).multiplyScalar(ang / dt);
}

export function randomQuat() {
  const u1 = Math.random(), u2 = Math.random(), u3 = Math.random();
  return new Quaternion(
    Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2),
    Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2),
    Math.sqrt(u1) * Math.sin(2 * Math.PI * u3),
    Math.sqrt(u1) * Math.cos(2 * Math.PI * u3),
  );
}
