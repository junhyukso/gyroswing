// Hand displacement from the accelerometer, one "still -> move -> still" segment at a time.
// Inside a segment the velocity must be 0 at both ends, so the velocity the integral is left with at the
// end is drift (sensor bias, gravity leaking through attitude error) — remove it linearly over the
// segment, then integrate to position (the zero-velocity update trick of foot-mounted trackers).
//
// Checks on real block-drill recordings (no ground truth needed):
//   - closure: the hand goes guard -> block -> guard; the summed displacement at each return to the
//     guard pose should come back to the same place (spread of those positions = accumulated error)
//   - direction: moves into blocks against attacks from the left should go left (-x), right +x, up +y
//   node tools/zupt.mjs [recording] [--segments]
import fs from 'node:fs';
import path from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';

const args = process.argv.slice(2);
const arg = args.find((a) => !a.startsWith('--'));
const file = arg || path.join('recordings', fs.readdirSync('recordings').filter((f) => f.endsWith('.json')).sort().pop());
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const S = rec.samples;
const IOS = { perm: [2, 0, 1], sign: [1, 1, 1], scale: Math.PI / 180, confident: true };
const cm = (v) => `(${(v.x * 100).toFixed(0)},${(v.y * 100).toFixed(0)},${(v.z * 100).toFixed(0)})`;
const P = { aStill: 0.6, wStill: 0.6, stillN: 3, maxSeg: 2.5 };
for (const a of args) { const m = /^--(\w+)=([\d.]+)$/.exec(a); if (m && m[1] in P) P[m[1]] = +m[2]; }

// ---- per sample: body-frame acceleration (gravity removed), rotation speed, blade direction
const c = new Controller();
c.fusion.mapping = { ...IOS }; c.fusion.accSign = -1; c.fusion.params.autoMap = false;
if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
if (rec.meta?.stances) c.arm.fromJSON(rec.meta.stances);
const toBody = (aE) => aE.clone().applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)).applyQuaternion(c.calib.Y);
const out = { pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3(), dir: new Vector3() };
const rows = [];
for (const s of S) {
  c.push({ ...s });
  if (!c.ready) continue;
  c.target(s.recv, out);
  rows.push({ t: s.t / 1000, a: toBody(c.fusion.aE), w: c.fusion.w.length(), dir: out.dir.clone(), hand: out.pos.clone() });
}
const T0 = rows[0].t;
// recv-time of the first sample, to line up drill events (recorded on the pc clock)
const recv0 = S.find((s) => s.t / 1000 >= T0)?.recv ?? S[0].recv;
const phoneOfRecv = (recv) => T0 + (recv - recv0) / 1000;

// ---- still flags (need stillN samples in a row)
const still = rows.map((r) => r.a.length() < P.aStill && r.w < P.wStill);
for (let i = 0; i < rows.length; i++) {
  let n = 0;
  for (let k = Math.max(0, i - P.stillN + 1); k <= i; k++) n += still[k] ? 1 : 0;
  rows[i].still = n === Math.min(P.stillN, i + 1);
}

// ---- segments between still periods
const segs = [];
let i = 0;
while (i < rows.length) {
  while (i < rows.length && !rows[i].still) i++;
  while (i < rows.length - 1 && rows[i + 1].still) i++;   // last still sample before the move
  const s0 = i;
  let j = i + 1;
  while (j < rows.length && !rows[j].still) j++;          // first still sample after it
  if (j >= rows.length) break;
  const dur = rows[j].t - rows[s0].t;
  if (j - s0 >= 3 && dur <= P.maxSeg) {
    // integrate a -> v (trapezoid), remove the end velocity linearly, integrate -> displacement
    const vs = [new Vector3()];
    for (let k = s0 + 1; k <= j; k++) {
      const dt = rows[k].t - rows[k - 1].t;
      vs.push(vs.at(-1).clone().addScaledVector(rows[k].a.clone().add(rows[k - 1].a), dt / 2));
    }
    const vEnd = vs.at(-1).clone();
    const d = new Vector3(), dNaive = new Vector3();
    let wPeak = 0;
    for (let k = s0 + 1; k <= j; k++) {
      const dt = rows[k].t - rows[k - 1].t;
      const u0 = (rows[k - 1].t - rows[s0].t) / dur, u1 = (rows[k].t - rows[s0].t) / dur;
      const v0 = vs[k - 1 - s0].clone().addScaledVector(vEnd, -u0), v1 = vs[k - s0].clone().addScaledVector(vEnd, -u1);
      d.addScaledVector(v0.add(v1), dt / 2);
      dNaive.addScaledVector(vs[k - 1 - s0].clone().add(vs[k - s0]), dt / 2);
      wPeak = Math.max(wPeak, rows[k].w);
    }
    segs.push({ t0: rows[s0].t, t1: rows[j].t, dur, d, dNaive, vEnd: vEnd.length(), wPeak, dirEnd: rows[j].dir, i0: s0, i1: j });
  }
  i = j;
}

// ---- still periods with their accumulated position
const holds = [];
const pos = new Vector3();
let si = 0;
for (let k = 0; k < rows.length; k++) {
  while (si < segs.length && segs[si].i1 <= k) { pos.add(segs[si].d); si++; }
  if (rows[k].still && (!holds.length || holds.at(-1).k1 < k - 1)) holds.push({ k0: k, k1: k, t: rows[k].t, pos: pos.clone(), dir: rows[k].dir, hand: rows[k].hand });
  else if (rows[k].still) holds.at(-1).k1 = k;
}
for (const h of holds) h.dur = rows[h.k1].t - rows[h.k0].t;

console.log(`${path.basename(file)} · ${(rows.at(-1).t - T0).toFixed(0)} s · ${segs.length} moves, ${holds.length} still periods`);
const mags = segs.map((s) => s.d.length() * 100).sort((a, b) => a - b);
const ends = segs.map((s) => s.vEnd).sort((a, b) => a - b);
console.log(`move size cm p50 ${mags[mags.length >> 1]?.toFixed(0)} p90 ${mags[Math.floor(mags.length * 0.9)]?.toFixed(0)} | velocity left at the stop (= drift removed) m/s p50 ${ends[ends.length >> 1]?.toFixed(2)} p90 ${ends[Math.floor(ends.length * 0.9)]?.toFixed(2)}`);
if (args.includes('--segments')) for (const s of segs) console.log(`  ${(s.t0 - T0).toFixed(2).padStart(6)}s ${s.dur.toFixed(2)}s wPeak ${s.wPeak.toFixed(1).padStart(4)}  d ${cm(s.d).padEnd(16)} naive ${cm(s.dNaive).padEnd(18)} vEnd ${s.vEnd.toFixed(2)}`);

// ---- closure at the guard pose: still periods whose blade points like the guard
const GUARD = new Vector3(-0.1, 0.8, -0.58).normalize();
const guards = holds.filter((h) => h.dur > 0.25 && h.dir.angleTo(GUARD) < 0.35);
if (guards.length > 2) {
  const mean = guards.reduce((a, h) => a.add(h.pos), new Vector3()).multiplyScalar(1 / guards.length);
  const dev = guards.map((h) => h.pos.distanceTo(mean) * 100);
  const drift = guards.slice(1).map((h, k) => h.pos.distanceTo(guards[k].pos) * 100).sort((a, b) => a - b);
  console.log(`\nguard returns: ${guards.length} | spread around their mean cm p50 ${dev.sort((a, b) => a - b)[dev.length >> 1].toFixed(0)} max ${Math.max(...dev).toFixed(0)} | between consecutive returns cm p50 ${drift[drift.length >> 1].toFixed(0)} p90 ${drift[Math.floor(drift.length * 0.9)].toFixed(0)}`);
}

// ---- block moves by attack side (drill events), or every hold vs the previous guard if no events
const drill = (rec.events || []).filter((e) => e.type === 'drill' && e.ev === 'attack');
const SIDE = { diagR: 'left', horizR: 'left', diagL: 'right', horizL: 'right', overhead: 'up', thrust: 'front' };
if (drill.length) {
  console.log('\nblock holds (displacement from the guard before the attack, cm; arm-model hand there):');
  const bySide = {};
  for (const e of drill) {
    const ta = phoneOfRecv(e.recv);
    const g = [...guards].reverse().find((h) => h.t <= ta + 0.3);
    // the block: the longest still period within 1.6 s after the attack started that isn't the guard
    const cand = holds.filter((h) => h.t > ta + 0.2 && h.t < ta + 1.8 && h.dur > 0.1 && h.dir.angleTo(GUARD) >= 0.35);
    const b = cand.sort((x, y) => y.dur - x.dur)[0];
    if (!g || !b) { console.log(`  ${(ta - T0).toFixed(1).padStart(6)}s ${e.key.padEnd(8)} (no clear guard/block hold)`); continue; }
    const d = b.pos.clone().sub(g.pos);
    (bySide[SIDE[e.key]] ||= []).push(d);
    console.log(`  ${(ta - T0).toFixed(1).padStart(6)}s ${e.key.padEnd(8)} ${SIDE[e.key].padEnd(5)} accel ${cm(d).padEnd(16)} arm model ${cm(b.hand.clone().sub(g.hand))}`);
  }
  for (const [side, list] of Object.entries(bySide)) {
    const m = list.reduce((a, d) => a.add(d), new Vector3()).multiplyScalar(1 / list.length);
    console.log(`  ${side.padEnd(5)} n=${list.length} mean ${cm(m)}`);
  }
}
