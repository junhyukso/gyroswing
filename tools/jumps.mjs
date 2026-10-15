// Sword "jumps" from late network data, on a real recording.
// Truth: the same samples fused as if they had arrived instantly (phone clock, no network).
// Game: the samples at their real arrival times, sampled at 240 Hz like the physics loop.
//   error  : angle between the game's predicted pose and the truth at the time it is meant for
//   jumps  : steps where the shown pose turns much faster than the phone really did (a snap when a
//            late burst lands) — count per minute, and the total excess angle
//   node tools/jumps.mjs [recording] [--sweep]
import fs from 'node:fs';
import path from 'node:path';
import { Quaternion } from 'three';
import { Fusion } from '../public/js/fusion.js';
import { quatAngle } from '../public/js/orient.js';

const args = process.argv.slice(2);
const arg = args.find((a) => !a.startsWith('--'));
const file = arg || path.join('recordings', fs.readdirSync('recordings').filter((f) => f.endsWith('.json')).sort().pop());
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const S = rec.samples;
const IOS = { perm: [2, 0, 1], sign: [1, 1, 1], scale: Math.PI / 180, confident: true };
const D = 180 / Math.PI;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };

function newFusion(params = {}) {
  const f = new Fusion();
  f.mapping = { ...IOS };
  f.accSign = -1;
  Object.assign(f.params, { autoMap: false }, params);
  return f;
}

// ---- truth: instant arrival, pose at each phone timestamp
const offMin = Math.min(...S.map((s) => s.recv - s.t));
const truth = [];
{
  const f = newFusion({ predictMs: 0, smoothMs: 0 });
  for (const s of S) {
    f.push({ ...s, recv: s.t + offMin });
    if (!f.ready) continue;
    const q = new Quaternion();
    f._rawPose(s.t + offMin, q);
    truth.push({ t: s.t, q, w: f.w.length() });
  }
}
let ti = 0;
function truthAt(t, out) {
  while (ti < truth.length - 2 && truth[ti + 1].t < t) ti++;
  while (ti > 0 && truth[ti].t > t) ti--;
  const a = truth[ti], b = truth[ti + 1];
  if (!b || t <= a.t) { out.copy(a.q); return a.w; }
  if (t >= b.t) { out.copy(b.q); return b.w; }
  const u = (t - a.t) / (b.t - a.t);
  out.copy(a.q).slerp(b.q, u);
  return a.w + (b.w - a.w) * u;
}

export function run(params = {}) {
  const f = newFusion(params);
  const H = 1000 / 240;
  const q = new Quaternion(), qPrev = new Quaternion(), qT = new Quaternion();
  let i = 0, has = false;
  const errs = [], jumps = [];
  let excess = 0;
  ti = 0;
  for (let now = S[0].recv; now < S.at(-1).recv; now += H) {
    while (i < S.length && S[i].recv <= now) f.push({ ...S[i++] });
    if (!f.ready || !f.poseAt(now, q)) continue;
    // the time this pose is meant for, on the phone clock
    const tFor = now - offMin + f.params.predictMs;
    const wTrue = truthAt(Math.min(tFor, S.at(-1).t), qT);
    errs.push(quatAngle(q, qT) * D);
    if (has) {
      const wShown = quatAngle(q, qPrev) / (H / 1000);       // rad/s the shown pose turned this step
      const lim = 1.6 * wTrue + 3;                           // what the phone could have done (+ slack)
      if (wShown > lim) { const ex = (wShown - lim) * (H / 1000) * D; excess += ex; jumps.push({ t: (now - S[0].recv) / 1000, deg: ex }); }
    }
    qPrev.copy(q); has = true;
  }
  const minutes = (S.at(-1).recv - S[0].recv) / 60000;
  // group consecutive jump steps into events
  const events = [];
  for (const j of jumps) {
    const e = events.at(-1);
    if (e && j.t - e.t1 < 0.03) { e.t1 = j.t; e.deg += j.deg; } else events.push({ t0: j.t, t1: j.t, deg: j.deg });
  }
  const big = events.filter((e) => e.deg > 3);
  return {
    errRms: Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length),
    errP95: pct(errs, 0.95),
    jumpsPerMin: big.length / minutes,
    excessDegPerMin: excess / minutes,
    worst: big.sort((a, b) => b.deg - a.deg).slice(0, 5).map((e) => `${e.t0.toFixed(2)}s ${e.deg.toFixed(0)}°`),
  };
}

const show = (name, r) => console.log(`${name.padEnd(34)} err RMS ${r.errRms.toFixed(1)}° p95 ${r.errP95.toFixed(1)}° | jumps>3° ${r.jumpsPerMin.toFixed(1)}/min, excess ${r.excessDegPerMin.toFixed(0)}°/min | worst ${r.worst.join(', ')}`);
console.log(path.basename(file), `${((S.at(-1).recv - S[0].recv) / 1000).toFixed(0)} s`);
show('current', run());
if (args.includes('--sweep')) {
  const OLD = { smoothMs: 0, staleHold: false, staleExtraMs: 0, snapDeg: 34 };
  show('before (2026-10-15 morning)', run(OLD));
  for (const smoothLateMs of [-100, 0, 10, 20]) show(`smooth 20, late from ${smoothLateMs}`, run({ smoothLateMs }));
  for (const smoothMs of [30, 40]) show(`smooth ${smoothMs}, late from 10`, run({ smoothMs }));
}
