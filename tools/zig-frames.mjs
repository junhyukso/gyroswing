// ZIG SIM conventions, fitted on a recording (so the game's ZIG input path uses measured, not guessed,
// frames): CoreMotion attitude direction (vs the gravity vector), gyro frame (vs attitude changes),
// user-acceleration sign (vs ARKit motion), and the fixed rotation between ARKit's camera frame and
// the device frame.   node tools/zig-frames.mjs [recording]
import fs from 'node:fs';
import path from 'node:path';
import { Quaternion, Vector3, Matrix3 } from 'three';

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const file = arg || path.join('recordings', fs.readdirSync('recordings').filter((f) => /^rec-.*\.json$/.test(f)).sort().pop());
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const Z = rec.events.filter((e) => e.type === 'zig' && e.d?.sensordata?.quaternion && e.d.sensordata.arkitrotation);
const D = 180 / Math.PI;
const rows = Z.map((e) => {
  const s = e.d.sensordata;
  return {
    t: e.recv / 1000,
    att: new Quaternion(...s.quaternion).normalize(),
    rot: new Quaternion(...s.arkitrotation).normalize(),
    pos: new Vector3(...s.arkitposition),
    g: new Vector3(...s.gravity), a: new Vector3(...s.accel), w: new Vector3(...s.gyro),
  };
});
console.log(path.basename(file), rows.length, 'samples');

// 1) attitude direction: gravity (device frame, G) should be the reference "down" (0,0,-1) seen in the device
const down = new Vector3(0, 0, -1);
let eA = 0, eB = 0;
for (const r of rows) {
  eA += r.g.clone().normalize().distanceTo(down.clone().applyQuaternion(r.att.clone().invert())); // att: device -> reference
  eB += r.g.clone().normalize().distanceTo(down.clone().applyQuaternion(r.att));                   // att: reference -> device
}
console.log(`attitude = device->reference: gravity error ${(eA / rows.length).toFixed(3)} | reference->device: ${(eB / rows.length).toFixed(3)}`);
const devToRef = eA < eB;
const qDR = (r) => (devToRef ? r.att.clone() : r.att.clone().invert()); // device -> reference

// 2) gyro frame: angular velocity from consecutive attitudes (device frame) vs reported gyro
let dotSum = 0, n = 0;
for (let k = 1; k < rows.length; k++) {
  const dt = rows[k].t - rows[k - 1].t;
  if (dt < 0.005 || dt > 0.05) continue;
  const dq = qDR(rows[k - 1]).invert().multiply(qDR(rows[k]));        // body-frame delta
  const ang = 2 * Math.acos(Math.min(1, Math.abs(dq.w)));
  if (ang < 0.02) continue;
  const axis = new Vector3(dq.x, dq.y, dq.z).normalize().multiplyScalar(Math.sign(dq.w) || 1);
  dotSum += axis.dot(rows[k].w.clone().normalize()); n++;
}
console.log(`gyro axis vs attitude change (device frame): mean cos ${(dotSum / n).toFixed(2)} over ${n} steps (1 = same frame & sign)`);

// 3) fixed rotation C: ARKit camera orientation = W · (device->reference) · C, W/C constant.
//    Relative rotations: rot_k^-1 rot_j = C^-1 (att_k^-1 att_j) C  -> align the rotation axes (Kabsch).
const A = [], B = [];
for (let k = 0; k + 6 < rows.length; k += 3) {
  const j = k + 6;
  const ra = rows[k].rot.clone().invert().multiply(rows[j].rot);
  const rb = qDR(rows[k]).invert().multiply(qDR(rows[j]));
  const angA = 2 * Math.acos(Math.min(1, Math.abs(ra.w))), angB = 2 * Math.acos(Math.min(1, Math.abs(rb.w)));
  if (angA < 0.15 || angB < 0.15 || Math.abs(angA - angB) > 0.1) continue;
  const axA = new Vector3(ra.x, ra.y, ra.z).normalize().multiplyScalar(Math.sign(ra.w) || 1);
  const axB = new Vector3(rb.x, rb.y, rb.z).normalize().multiplyScalar(Math.sign(rb.w) || 1);
  A.push(axA); B.push(axB);
}
// Kabsch: find R with R·b ≈ a  (C^-1 maps device axes to camera axes)
function kabsch(src, dst) {
  const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < src.length; i++) {
    const s = src[i].toArray(), d = dst[i].toArray();
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) H[r][c] += s[r] * d[c];
  }
  // polar decomposition by iteration (R = H^T (H H^T)^-1/2 ... ) — use quaternion method (Horn)
  const [[Sxx, Sxy, Sxz], [Syx, Syy, Syz], [Szx, Szy, Szz]] = H;
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  let v = [1, 0.1, 0.1, 0.1];
  for (let it = 0; it < 200; it++) { // power iteration on N + 4I (largest eigenvector)
    const w = N.map((row, r) => row.reduce((a, x, c) => a + x * v[c], 0) + 4 * v[r]);
    const l = Math.hypot(...w); v = w.map((x) => x / l);
  }
  return new Quaternion(v[1], v[2], v[3], v[0]).normalize();
}
const Ci = kabsch(B, A); // device axis -> camera axis
const res = A.map((a, i) => a.angleTo(B[i].clone().applyQuaternion(Ci)) * D).sort((x, y) => x - y);
const m = new Matrix3().setFromMatrix4(new (await import('three')).Matrix4().makeRotationFromQuaternion(Ci));
console.log(`camera <- device rotation (from ${A.length} motion pairs): quat ${Ci.toArray().map((x) => x.toFixed(3))}  axis error p50 ${res[res.length >> 1].toFixed(1)}° p90 ${res[Math.floor(res.length * 0.9)].toFixed(1)}°`);
console.log('  matrix (rows):', [0, 1, 2].map((r) => [0, 1, 2].map((c) => m.elements[c * 3 + r].toFixed(2)).join(' ')).join(' | '));
// W = rot · C^-1 ... with rot = W · att · C  ->  W = rot · C^-1 · att^-1 ; C = Ci^-1
const C = Ci.clone().invert();
const Ws = rows.map((r) => r.rot.clone().multiply(C.clone().invert()).multiply(qDR(r).invert()));
const Wref = Ws[Ws.length >> 1];
const wd = Ws.map((w) => w.angleTo(Wref) * D).sort((x, y) => x - y);
console.log(`ARKit world <- reference: stable to p50 ${wd[wd.length >> 1].toFixed(1)}° p90 ${wd[Math.floor(wd.length * 0.9)].toFixed(1)}°  W ${Wref.toArray().map((x) => x.toFixed(3))}`);

// 4) acceleration sign: ARKit position second difference (world) vs accel rotated to ARKit world
let cp = 0, cn = 0, nn = 0;
for (let k = 2; k < rows.length - 2; k++) {
  const dt = (rows[k + 2].t - rows[k - 2].t) / 4;
  if (!(dt > 0.008 && dt < 0.03)) continue;
  const acc = rows[k + 2].pos.clone().add(rows[k - 2].pos).addScaledVector(rows[k].pos, -2).multiplyScalar(1 / (4 * dt * dt)); // m/s^2, smoothed
  if (acc.length() < 2 || acc.length() > 40) continue;
  const aW = rows[k].a.clone().multiplyScalar(9.81).applyQuaternion(qDR(rows[k])).applyQuaternion(Wref);
  cp += acc.clone().normalize().dot(aW.clone().normalize()); nn++;
}
console.log(`user accel vs ARKit acceleration: mean cos ${(cp / nn).toFixed(2)} over ${nn} samples (+1: accel is motion direction, -1: inverted)`);
