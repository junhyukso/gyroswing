// Per-swing cutting energy on a recording: ½·m_eff·v² at the cutting zone, m_eff from arm involvement.
//   node tools/cut-energy.mjs [recording]
import fs from 'node:fs';
import path from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const file = arg || path.join('recordings', fs.readdirSync('recordings').filter((f) => f.endsWith('.json')).sort().pop());
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
// target-based (no physics); the game judges the physical sword, ~1.7x these energies — see physics-replay.mjs
const P = { cutEnergy: 40, mWrist: 0.35, mArm: 1.5 };
const c = new Controller();
c.fusion.mapping = { perm: [2, 0, 1], sign: [1, 1, 1], scale: Math.PI / 180, confident: true }; c.fusion.accSign = -1;
if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
const out = { pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3(), dir: new Vector3() };
const S = rec.samples; let i = 0; const swings = []; let cur = null;
for (let t = S[0].recv; t < S.at(-1).recv; t += 1000 / 240) {
  while (i < S.length && S[i].recv <= t) c.push({ ...S[i++] });
  if (!c.ready) continue;
  c.target(t, out);
  const r = out.dir.clone().multiplyScalar(0.75);
  const v = out.v.clone().add(new Vector3().crossVectors(out.w, r));
  const sp = v.addScaledVector(out.dir, -v.dot(out.dir)).length();
  const m = P.mWrist + (P.mArm - P.mWrist) * c.involvement;
  const e = 0.5 * m * sp * sp;
  if (c.fusion.w.length() > 5) { if (!cur) cur = { e: 0 }; if (e > cur.e) Object.assign(cur, { e, sp, inv: c.involvement, r: c.leverR }); }
  else if (cur) { swings.push(cur); cur = null; }
}
console.log(`# ${path.basename(file)}: ${swings.length} swings`);
console.log(swings.map((s) => `${s.e.toFixed(0)}J(${s.sp.toFixed(1)}m/s,팔${(s.inv * 100).toFixed(0)}%)`).join('  '));
console.log(`>= ${P.cutEnergy} J (would cut if edge-aligned): ${swings.filter((s) => s.e >= P.cutEnergy).length}/${swings.length}`);
