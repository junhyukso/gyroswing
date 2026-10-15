// Compare hand models on real recordings at physics rate.
//   node tools/eval-hand.mjs <thrust-recording> <swing-recording>
// thrust rec : forward reach of each thrust-out, what's left 0.6 s after each retraction
// swing rec  : cutting-zone blade speed per swing (wrist flicks should stay slow), hand offset when long still
import fs from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';

const [thrustFile, swingFile] = process.argv.slice(2);
const IOS = { perm: [2, 0, 1], sign: [1, 1, 1], scale: Math.PI / 180, confident: true };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };

function run(rec, params, armParams = {}) {
  const c = new Controller();
  c.fusion.mapping = { ...IOS };
  c.fusion.accSign = -1;
  if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
  Object.assign(c.params, params);
  Object.assign(c.arm.params, armParams);
  const out = { pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3(), dir: new Vector3() };
  const S = rec.samples;
  const rows = [];
  let i = 0;
  for (let t = S[0].recv; t < S.at(-1).recv; t += 1000 / 240) {
    let fresh = false;
    while (i < S.length && S[i].recv <= t) { c.push({ ...S[i++] }); fresh = true; }
    if (!c.ready) continue;
    c.target(t, out);
    const r = out.dir.clone().multiplyScalar(0.75);
    const v = out.v.clone().add(new Vector3().crossVectors(out.w, r));
    const vPerp = v.addScaledVector(out.dir, -v.dot(out.dir)).length();
    const base = c.arm.baseGrip(out.dir, new Vector3());
    rows.push({ t: (t - S[0].recv) / 1000, w: c.fusion.w.length(), a: c.fusion.aE.length(), aBody: fresh ? c.fusion.aE.clone() : null,
      handOff: out.pos.clone().sub(base), vPerp, still: c.arm.stillT });
  }
  return rows;
}

function thrustScore(rows, rec) {
  // thrust events found from the accelerometer in body frame (forward = -z)
  const c = new Controller();
  c.fusion.mapping = { ...IOS }; c.fusion.accSign = -1;
  if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
  const evOut = [], evBack = [];
  let last = -9;
  for (const s of rec.samples) {
    c.push({ ...s });
    if (!c.ready) continue;
    const t = (s.t - rec.samples[0].t) / 1000;
    const a = c.fusion.aE.clone().applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)).applyQuaternion(c.calib.Y);
    if (a.length() < 12 || t - last < 0.6) continue;
    const d = a.clone().normalize();
    if (d.z < -0.6) { evOut.push(t); last = t; } else if (d.z > 0.6) { evBack.push(t); last = t; }
  }
  const at = (t) => rows.reduce((b, r) => (Math.abs(r.t - t) < Math.abs(b.t - t) ? r : b), rows[0]);
  const reach = evOut.map((t) => Math.max(...rows.filter((r) => r.t > t - 0.25 && r.t < t + 0.5).map((r) => -r.handOff.z)));
  const after = evBack.map((t) => at(t + 0.6).handOff.length());
  return { reach, after };
}

function swingScore(rows) {
  const swings = [];
  let cur = null;
  for (const r of rows) {
    if (r.w > 5) { if (!cur) cur = 0; cur = Math.max(cur, r.vPerp); }
    else if (cur !== null) { swings.push(cur); cur = null; }
  }
  const longStill = rows.filter((r) => r.still > 2.2).map((r) => r.handOff.length());
  return { swings, longStillP90: pct(longStill, 0.9) };
}

const T = JSON.parse(fs.readFileSync(thrustFile, 'utf8')), W = JSON.parse(fs.readFileSync(swingFile, 'utf8'));
const variants = {
  '게이트 방식': [{ handModel: 'gated' }],
  '융합 방식 (현재 기본값)': [{ handModel: 'fused' }],
};
const table = {};
for (const [name, [cp, ap]] of Object.entries(variants)) {
  const t = thrustScore(run(T, cp, ap), T);
  const s = swingScore(run(W, cp, ap));
  const sw = s.swings;
  table[name] = {
    '찌르기 도달 cm': t.reach.map((x) => (x * 100).toFixed(0)).join(' '),
    '거둔 뒤 cm': t.after.map((x) => (x * 100).toFixed(0)).join(' '),
    '손목스윙 칼날속도 p50/p90/max': `${pct(sw, 0.5).toFixed(1)} / ${pct(sw, 0.9).toFixed(1)} / ${Math.max(...sw).toFixed(1)}`,
    '≥9m/s 스윙 수': `${sw.filter((x) => x >= 9).length}/${sw.length}`,
    '오래 정지 시 손 밀림 p90 cm': (s.longStillP90 * 100).toFixed(1),
  };
}
console.table(table);
