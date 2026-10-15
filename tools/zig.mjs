// ZIG SIM Pro (ARKit) recording analysis: is ARKit's device position good enough to place the hands?
//   - holds (|gyro| < 0.8 rad/s for 0.4 s+): position, feature points
//   - returns to the same pose (rotation within 20° of an earlier hold): how far apart their positions
//     are (the accelerometer-only attempt was off by 15–23 cm per return)
//   - deliberate moves (pose kept, hand moved): the distance ARKit reports
//   - swings (|gyro| > 5 rad/s): position steps (jumps = relocalisation), ARKit rotation vs the
//     motion-sensor attitude (lag / disagreement), ARKit pose latency vs the gyro
//   node tools/zig.mjs [recording]
import fs from 'node:fs';
import path from 'node:path';
import { Quaternion, Vector3 } from 'three';

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const file = arg || path.join('recordings', fs.readdirSync('recordings').filter((f) => /^rec-.*\.json$/.test(f)).sort().pop());
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const Z = rec.events.filter((e) => e.type === 'zig' && e.d?.sensordata?.arkitposition);
if (!Z.length) { console.log('no ZIG SIM ARKit data in', file); process.exit(0); }
const D = 180 / Math.PI;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const cm = (v) => `(${(v.x * 100).toFixed(1)}, ${(v.y * 100).toFixed(1)}, ${(v.z * 100).toFixed(1)})`;

const rows = Z.map((e) => {
  const s = e.d.sensordata;
  const r = s.arkitrotation, q = s.quaternion, g = s.gyro;
  return {
    t: e.recv / 1000,
    pos: new Vector3(...s.arkitposition),
    rot: new Quaternion(r[0], r[1], r[2], r[3]).normalize(),
    att: q ? new Quaternion(q[0], q[1], q[2], q[3]).normalize() : null,
    w: g ? Math.hypot(g[0], g[1], g[2]) : 0,
    fp: s.arkitfeaturepoints?.count ?? 0,
  };
});
const T0 = rows[0].t;
console.log(`${path.basename(file)} · ${(rows.at(-1).t - T0).toFixed(1)} s · ${rows.length} ARKit poses`);

// ---- holds
const holds = [];
let cur = null;
for (const r of rows) {
  if (r.w < 0.8) { if (!cur) cur = []; cur.push(r); }
  else { if (cur && cur.at(-1).t - cur[0].t >= 0.4) holds.push(cur); cur = null; }
}
if (cur && cur.at(-1).t - cur[0].t >= 0.4) holds.push(cur);
const H = holds.map((L) => {
  const mid = L[L.length >> 1];
  const pos = L.reduce((a, r) => a.add(r.pos), new Vector3()).multiplyScalar(1 / L.length);
  const jitter = Math.sqrt(L.reduce((a, r) => a + r.pos.distanceToSquared(pos), 0) / L.length);
  return { t: L[0].t - T0, dur: L.at(-1).t - L[0].t, pos, rot: mid.rot, jitter, fp: pct(L.map((r) => r.fp), 0.5) };
});
console.log(`\nholds (|gyro| < 0.8 rad/s, 0.4 s+): ${H.length}`);
for (const h of H) console.log(`  ${h.t.toFixed(1).padStart(5)}s ${h.dur.toFixed(1)}s  pos cm ${cm(h.pos).padEnd(24)} jitter ${(h.jitter * 1000).toFixed(1)} mm  features ${h.fp}`);

// ---- returns to an earlier pose: same rotation (within 20°), position should be close
const pairs = [];
for (let i = 0; i < H.length; i++) for (let j = i + 1; j < H.length; j++) {
  const ang = H[i].rot.angleTo(H[j].rot) * D;
  if (ang < 20) pairs.push({ i, j, ang, dist: H[i].pos.distanceTo(H[j].pos) * 100 });
}
if (pairs.length) {
  const ds = pairs.map((p) => p.dist);
  console.log(`\nsame pose again (rotation < 20° apart): ${pairs.length} pairs, position apart cm p50 ${pct(ds, 0.5).toFixed(1)} p90 ${pct(ds, 0.9).toFixed(1)} max ${Math.max(...ds).toFixed(1)}`);
  console.log('  (a hand put back "in the same pose" by a person differs a few cm by itself)');
}

// ---- deliberate moves: consecutive holds with little rotation change but a big position change
console.log('\nmoves between consecutive holds (rotation change, distance):');
for (let k = 1; k < H.length; k++) {
  const ang = H[k - 1].rot.angleTo(H[k].rot) * D, d = H[k].pos.clone().sub(H[k - 1].pos);
  console.log(`  ${H[k - 1].t.toFixed(1).padStart(5)}s -> ${H[k].t.toFixed(1).padStart(5)}s  turned ${ang.toFixed(0).padStart(3)}°  moved ${(d.length() * 100).toFixed(1).padStart(5)} cm ${cm(d)}`);
}

// ---- swings: position continuity and orientation agreement
const fast = rows.filter((r) => r.w > 5);
const steps = [];
for (let k = 1; k < rows.length; k++) {
  const dt = rows[k].t - rows[k - 1].t;
  if (dt <= 0) continue;
  steps.push({ v: rows[k].pos.distanceTo(rows[k - 1].pos) / dt, w: rows[k].w, t: rows[k].t - T0, d: rows[k].pos.distanceTo(rows[k - 1].pos) });
}
const vs = steps.filter((s) => s.w > 5).map((s) => s.v);
const jumps = steps.filter((s) => s.v > 8 && s.d > 0.05);
console.log(`\nswings (|gyro| > 5 rad/s): ${fast.length} poses (${((fast.length / rows.length) * 100).toFixed(0)}%)  position speed m/s p50 ${pct(vs, 0.5).toFixed(2)} p95 ${pct(vs, 0.95).toFixed(2)}  features p50 ${pct(fast.map((r) => r.fp), 0.5)}`);
console.log(`position jumps (> 8 m/s and > 5 cm in one step): ${jumps.length}${jumps.length ? ' at ' + jumps.slice(0, 8).map((j) => `${j.t.toFixed(1)}s ${(j.d * 100).toFixed(0)}cm`).join(', ') : ''}`);

// ARKit camera rotation vs the motion-sensor attitude: their relative rotation should stay constant
if (rows[0].att) {
  const rel = rows.map((r) => r.rot.clone().multiply(r.att.clone().invert()));
  const ref = rel[Math.floor(rel.length / 2)];
  const dev = rel.map((q) => q.angleTo(ref) * D);
  const devFast = rows.map((r, k) => (r.w > 5 ? dev[k] : null)).filter((x) => x != null);
  const devSlow = rows.map((r, k) => (r.w < 1 ? dev[k] : null)).filter((x) => x != null);
  console.log(`ARKit rotation vs motion attitude: slow p50 ${pct(devSlow, 0.5).toFixed(1)}° | swinging p50 ${pct(devFast, 0.5).toFixed(1)}° p95 ${pct(devFast, 0.95).toFixed(1)}°`);
}

// latency of ARKit's pose vs the gyro in the same packet: shift that best lines up |ω| from ARKit
// rotation differences with |gyro|
const wA = rows.map((r, k) => (k ? r.rot.angleTo(rows[k - 1].rot) / Math.max(1e-3, r.t - rows[k - 1].t) : 0));
let best = { lag: 0, c: -1 };
for (let lag = -8; lag <= 8; lag++) {
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 10; k < rows.length - 10; k++) {
    const x = rows[k].w, y = wA[k + lag];
    if (y === undefined) continue;
    sxy += x * y; sxx += x * x; syy += y * y;
  }
  const c = sxy / Math.sqrt(sxx * syy);
  if (c > best.c) best = { lag, c };
}
console.log(`ARKit pose lags the gyro by ${best.lag} packets (~${(best.lag * 16.7).toFixed(0)} ms), correlation ${best.c.toFixed(2)}`);
