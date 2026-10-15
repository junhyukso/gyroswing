// Block-drill recording with drill events (recorded since 2026-10-15): for every attack, what the
// controller made of the player's guard at the moment the strike started and at its middle —
// blade/edge direction, hand position, block-pose weight and the nearest block pose.
//   node tools/block-events.mjs [recording]
import fs from 'node:fs';
import path from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const file = arg || path.join('recordings', fs.readdirSync('recordings').filter((f) => f.endsWith('.json')).sort().pop());
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const IOS = { perm: [2, 0, 1], sign: [1, 1, 1], scale: Math.PI / 180, confident: true };
const LEVEL_STRIKE = [0.5, 0.38, 0.3, 0.28];
const HINT = (key) => ({
  y: key === 'overhead' ? 1.75 : key === 'diagR' || key === 'diagL' ? 1.65 : key === 'thrust' ? 1.1 : 1.0,
  side: key === 'diagR' || key === 'horizR' ? -1 : key === 'diagL' || key === 'horizL' ? 1 : 0, // -1 = from the player's left
});
const f2 = (v) => v.toArray().map((x) => x.toFixed(2)).join(',');

const c = new Controller();
c.fusion.mapping = { ...IOS };
c.fusion.accSign = -1;
if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
if (rec.meta?.stances) c.arm.fromJSON(rec.meta.stances);
const S = rec.samples, t0 = S[0].recv;
const ev = rec.events.filter((e) => e.type === 'drill');
const attacks = [];
for (const e of ev) {
  if (e.ev === 'attack') attacks.push({ ...e, t: (e.recv - t0) / 1000 });
  else if (attacks.length) Object.assign(attacks.at(-1), { result: e, tEnd: (e.recv - t0) / 1000 });
}
const out = { pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3(), dir: new Vector3() };
const _blk = new Vector3();
let i = 0, k = 0;
const probes = attacks.flatMap((a, n) => {
  const strike = a.t + a.windup;
  return [{ n, at: strike, tag: 'strike' }, { n, at: strike + LEVEL_STRIKE[a.level] * 0.5, tag: 'mid' }];
}).sort((x, y) => x.at - y.at);
const rows = attacks.map(() => ({}));
for (let t = t0; t < S.at(-1).recv; t += 1000 / 240) {
  while (i < S.length && S[i].recv <= t) c.push({ ...S[i++] });
  if (!c.ready) continue;
  const ts = (t - t0) / 1000;
  const a = attacks.find((x) => ts >= x.t && ts <= (x.tEnd ?? x.t + 3));
  c.blockHint = a ? HINT(a.key) : null;
  c.target(t, out);
  while (k < probes.length && ts >= probes[k].at) {
    const p = probes[k++];
    const edge = new Vector3(1, 0, 0).applyQuaternion(out.quat);
    // nearest block pose
    let best = null;
    for (const b of c.arm.blockPoses) {
      const side = new Vector3().crossVectors(out.dir, edge);
      const cs = (out.dir.dot(b.dir) + edge.dot(b.edge) + side.dot(b.side) - 1) / 2;
      const ang = (Math.acos(Math.max(-1, Math.min(1, cs))) * 180) / Math.PI;
      if (!best || ang < best.ang) best = { id: b.id, ang };
    }
    rows[p.n][p.tag] = { dir: f2(out.dir), edge: f2(edge), hand: f2(out.pos), w: c.blockW.toFixed(2), wRate: c.fusion.w.length().toFixed(1), near: `${best.id} ${best.ang.toFixed(0)}°` };
  }
}
console.log(path.basename(file));
attacks.forEach((a, n) => {
  console.log(`\n${a.t.toFixed(1)}s L${a.level + 1} ${a.key} (${a.label}) -> ${a.result?.line ?? '?'}`);
  for (const tag of ['strike', 'mid']) {
    const r = rows[n][tag];
    if (r) console.log(`  ${tag.padEnd(6)} dir ${r.dir}  edge ${r.edge}  hand ${r.hand}  blockW ${r.w}  |w| ${r.wRate}  nearest ${r.near}`);
  }
});
