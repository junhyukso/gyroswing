// Orientation math shared by game, simulator and node tests.
//
// Frames
//   device (D)  : W3C device frame. x = right of screen, y = top of screen, z = out of screen.
//   earth  (E)  : W3C earth frame. x = east-ish, y = north-ish (iOS: arbitrary yaw), z = up.
//   world  (W)  : three.js world. x = right, y = up, z = toward the player (forward is -z).
//   sword  (S)  : x = true edge, y = blade (grip -> tip), z = flat normal (x × y).
//
// A device quaternion q (D -> E) comes from deviceorientation alpha/beta/gamma:
//   R = Rz(alpha) · Rx(beta) · Ry(gamma)
import { Quaternion, Vector3, Matrix4, Euler, MathUtils } from 'three';

const D2R = Math.PI / 180;
const _e = new Euler();

/** W3C deviceorientation (degrees) -> quaternion D->E. */
export function eulerToQuat(alpha, beta, gamma, out = new Quaternion()) {
  _e.set(beta * D2R, gamma * D2R, alpha * D2R, 'ZXY'); // three 'ZXY' = Rz·Rx·Ry
  return out.setFromEuler(_e);
}

/** quaternion D->E -> W3C {alpha, beta, gamma} in degrees, using the spec's ranges. */
export function quatToEuler(q) {
  const m = new Matrix4().makeRotationFromQuaternion(q).elements; // column-major
  // row-major R[i] as in the spec
  const R = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  let alpha, beta, gamma;
  const PI = Math.PI;
  if (R[8] > 1e-9) {
    alpha = Math.atan2(-R[1], R[4]);
    beta = Math.asin(MathUtils.clamp(R[7], -1, 1));
    gamma = Math.atan2(-R[6], R[8]);
  } else if (R[8] < -1e-9) {
    alpha = Math.atan2(R[1], -R[4]);
    beta = -Math.asin(MathUtils.clamp(R[7], -1, 1));
    beta += beta >= 0 ? -PI : PI;
    gamma = Math.atan2(R[6], -R[8]);
  } else if (R[6] > 0) {
    alpha = Math.atan2(-R[1], R[4]);
    beta = Math.asin(MathUtils.clamp(R[7], -1, 1));
    gamma = -PI / 2;
  } else if (R[6] < 0) {
    alpha = Math.atan2(R[1], -R[4]);
    beta = -Math.asin(MathUtils.clamp(R[7], -1, 1));
    beta += beta >= 0 ? -PI : PI;
    gamma = -PI / 2;
  } else {
    alpha = Math.atan2(R[3], R[0]);
    beta = R[7] > 0 ? PI / 2 : -PI / 2;
    gamma = 0;
  }
  if (alpha < 0) alpha += 2 * PI;
  return { alpha: alpha / D2R, beta: beta / D2R, gamma: gamma / D2R };
}

/** Earth (z-up) -> three world (y-up): rotation of -90° about x. */
export const Q_EW = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);

/** Quaternion for rotating by angular velocity w (rad/s, any frame) over dt seconds. */
export function expRot(wx, wy, wz, dt, out = new Quaternion()) {
  const ang = Math.hypot(wx, wy, wz) * dt;
  if (ang < 1e-9) return out.set(0, 0, 0, 1);
  const s = Math.sin(ang / 2) / (ang / dt);
  return out.set(wx * s, wy * s, wz * s, Math.cos(ang / 2));
}

/** Rotation vector (axis * angle, radians) of quaternion q, shortest path. */
export function logRot(q, out = new Vector3()) {
  let { x, y, z, w } = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.hypot(x, y, z);
  if (s < 1e-9) return out.set(2 * x, 2 * y, 2 * z);
  const ang = 2 * Math.atan2(s, w);
  return out.set((x / s) * ang, (y / s) * ang, (z / s) * ang);
}

/** Angle in radians between two orientations. */
export function quatAngle(a, b) {
  const d = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, d));
}

/** Build a quaternion from three orthonormal column vectors (a frame's x, y, z axes). */
export function quatFromBasis(x, y, z, out = new Quaternion()) {
  const m = new Matrix4().makeBasis(x, y, z);
  return out.setFromRotationMatrix(m);
}

/** Sword pose from a blade direction and an edge hint (edge = sword +x, blade = +y). */
export function poseFromDir(dir, edgeHint, out = new Quaternion()) {
  const b = dir.clone().normalize();
  const e = edgeHint ? edgeHint.clone() : new Vector3(0, -1, 0);
  e.addScaledVector(b, -e.dot(b));
  if (e.lengthSq() < 1e-4) e.set(0, 0, -1).addScaledVector(b, -b.z);
  e.normalize();
  const n = new Vector3().crossVectors(e, b);
  return quatFromBasis(e, b, n, out);
}

/** Rotation about world +Y. */
export function yawQuat(angle, out = new Quaternion()) {
  return out.setFromAxisAngle(new Vector3(0, 1, 0), angle);
}

export const AXIS_X = new Vector3(1, 0, 0);
export const AXIS_Y = new Vector3(0, 1, 0);
export const AXIS_Z = new Vector3(0, 0, 1);
