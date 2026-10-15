// How much the block-pose hand placement engages on recordings (swings should stay ~0).
//   node tools/block-fp.mjs <rec> [<rec> ...]
import fs from 'node:fs';
import { Quaternion, Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';
const IOS = { perm: [2, 0, 1], sign: [1, 1, 1], scale: Math.PI / 180, confident: true };
for (const f of process.argv.slice(2)) {
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  const c = new Controller(); if (process.env.ALWAYS) c.params.blockAlways = true; c.fusion.mapping = { ...IOS }; c.fusion.accSign = -1;
  if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
  const out = { pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3(), dir: new Vector3() };
  const S = rec.samples; let i = 0, n = 0, on = 0, onFast = 0, fast = 0, maxShift = 0; const segs = []; let cur = null;
  for (let t = S[0].recv; t < S.at(-1).recv; t += 1000 / 120) {
    while (i < S.length && S[i].recv <= t) c.push({ ...S[i++] });
    if (!c.ready) continue;
    c.target(t, out); n++;
    const w = c.fusion.w.length();
    if (w > 3) fast++;
    if (c.blockW > 0.3) { on++; if (w > 3) onFast++; if (!cur) cur = { t: (t - S[0].recv) / 1000, len: 0 }; cur.len += 1 / 120; if (!cur.dir && cur.len > 0.1) { cur.dir = out.dir.clone(); cur.edge = new Vector3(1, 0, 0).applyQuaternion(out.quat); cur.pos = out.pos.clone(); } }
    else if (cur) { segs.push(cur); cur = null; }
  }
  console.log(f.split(/[\/]/).pop(), `engaged ${(100 * on / n).toFixed(1)}% of time, during |w|>3: ${(100 * onFast / Math.max(1, fast)).toFixed(1)}%, segments ${segs.length}:`, segs.filter((s) => s.len > 0.15).map((s) => `
   ${s.t.toFixed(1)}s/${s.len.toFixed(2)} dir ${s.dir?.toArray().map((x) => x.toFixed(2))} edge ${s.edge?.toArray().map((x) => x.toFixed(2))} hand ${s.pos?.toArray().map((x) => x.toFixed(2))}`).join(''));
}
