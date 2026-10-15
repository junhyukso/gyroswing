// Per-swing stats on recordings: peak |ω|, lever radius r = |a|/sqrt(ω⁴+α²) near the peak, peak |a|,
// and the sensor-only "hand speed" proxy. Compare wrist vs arm recordings.
//   node tools/swing-stats.mjs <rec> [<rec> ...]
import fs from 'node:fs';
import path from 'node:path';
import { Fusion } from '../public/js/fusion.js';
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
for (const f of process.argv.slice(2)) {
  const rec = JSON.parse(fs.readFileSync(f));
  const fu = new Fusion(); fu.mapping = { perm: [2, 0, 1], sign: [1, 1, 1], scale: Math.PI / 180, confident: true }; fu.accSign = -1;
  const rows = [];
  let vh = null, quiet = 0, tPrev = null;
  for (const s of rec.samples) {
    fu.push({ ...s });
    if (!fu.ready) continue;
    const dt = tPrev === null ? 0 : Math.min(0.05, (s.t - tPrev) / 1000); tPrev = s.t;
    const w = fu.w.length();
    // hand speed proxy: integrate acceleration from the last quiet moment (|ω| < 2 for 50 ms)
    quiet = w < 2 ? quiet + dt : 0;
    if (!vh || quiet > 0.05) vh = fu.aE.clone().multiplyScalar(0);
    else vh.addScaledVector(fu.aE, dt);
    rows.push({ w, wd: fu.wDot.length(), a: fu.aE.length(), vh: vh.length() });
  }
  const swings = []; let cur = null;
  rows.forEach((r, i) => {
    if (r.w > 5) { if (!cur) cur = { peak: 0, pk: i, i0: i }; if (r.w > cur.peak) { cur.peak = r.w; cur.pk = i; } }
    else if (cur) { cur.i1 = i; swings.push(cur); cur = null; }
  });
  const res = swings.map((s) => {
    const win = rows.slice(s.i0, s.i1);
    const rs = win.filter((r) => r.w > 3).map((r) => r.a / Math.sqrt(r.w ** 4 + r.wd ** 2));
    return { peakW: s.peak, rMed: pct(rs, 0.5), rP80: pct(rs, 0.8), aMax: Math.max(...win.map((r) => r.a)), vh: Math.max(...win.map((r) => r.vh)), dur: (s.i1 - s.i0) / 60 };
  });
  const big = res.filter((r) => r.peakW > 8);
  console.log(`\n# ${path.basename(f)}: ${res.length} swings, ${big.length} with peak |ω| > 8`);
  console.log('peak ω / r med / r p80 / max|a| :', big.map((r) => `${r.peakW.toFixed(0)}/${r.rMed.toFixed(2)}/${r.rP80.toFixed(2)}/${r.aMax.toFixed(0)}`).join('  '));
  console.log(`hand speed proxy (m/s) over big swings: p25 ${pct(big.map((r) => r.vh), 0.25).toFixed(2)} p50 ${pct(big.map((r) => r.vh), 0.5).toFixed(2)} p75 ${pct(big.map((r) => r.vh), 0.75).toFixed(2)} p90 ${pct(big.map((r) => r.vh), 0.9).toFixed(2)}`);
  console.log(`r med over big swings: p25 ${pct(big.map((r) => r.rMed), 0.25).toFixed(2)} p50 ${pct(big.map((r) => r.rMed), 0.5).toFixed(2)} p75 ${pct(big.map((r) => r.rMed), 0.75).toFixed(2)} | max|a| p50 ${pct(big.map((r) => r.aMax), 0.5).toFixed(0)} p90 ${pct(big.map((r) => r.aMax), 0.9).toFixed(0)} | peak ω p50 ${pct(big.map((r) => r.peakW), 0.5).toFixed(1)} p90 ${pct(big.map((r) => r.peakW), 0.9).toFixed(1)}`);
}
