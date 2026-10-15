// Phone-camera feasibility (camera probe on the phone page, recorded with F9): can the lens of a phone
// held like a sword hilt see enough to track position?
//   - per rotation-speed band: frame rate, sharpness (mean |Laplacian|), feature cells (of 300)
//   - held poses (|w| < 1 rad/s for 0.3 s+): the case camera tracking would be used for
//   - thumbnails written to recordings/<name>-cam/ to look at (fingers on the lens? floor? blur?)
//   node tools/camprobe.mjs [recording]
import fs from 'node:fs';
import path from 'node:path';

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const file = arg || path.join('recordings', fs.readdirSync('recordings').filter((f) => f.endsWith('.json')).sort().pop());
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const ev = rec.events || [];
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');

const frames = ev.filter((e) => e.type === 'cam' && !e.off);
const imgs = ev.filter((e) => e.type === 'camimg');
console.log(`${path.basename(file)}: ${frames.length} camera frames, ${imgs.length} thumbnails`);
for (const i of ev.filter((e) => e.type === 'caminfo')) console.log('camera:', i.facing, JSON.stringify(i.settings), 'caps', JSON.stringify(i.caps));
if (!frames.length) process.exit(0);

for (const facing of [...new Set(frames.map((f) => f.facing))]) {
  const F = frames.filter((f) => f.facing === facing);
  console.log(`\n== ${facing === 'user' ? 'front' : 'rear'} camera: ${F.length} frames`);
  const usable = (f) => f.cells >= 60 && f.sharp >= 4;
  const bands = [[0, 1], [1, 3], [3, 6], [6, 10], [10, 99]];
  console.log('  |w| rad/s   frames  fps(med)  sharp p50  cells p10/p50  usable%');
  for (const [a, b] of bands) {
    const B = F.filter((f) => f.w >= a && f.w < b);
    if (!B.length) continue;
    const fps = 1000 / pct(B.map((f) => f.dt).filter((d) => d > 0), 0.5);
    console.log(`  ${String(a).padStart(2)}-${String(b).padEnd(3)}      ${String(B.length).padStart(6)}  ${f1(fps).padStart(7)}  ${f1(pct(B.map((f) => f.sharp), 0.5)).padStart(9)}  ${String(pct(B.map((f) => f.cells), 0.1)).padStart(5)}/${String(pct(B.map((f) => f.cells), 0.5)).padEnd(5)}  ${f1((100 * B.filter(usable).length) / B.length).padStart(7)}`);
  }
  // held poses
  const holds = [];
  let cur = null;
  for (const f of F) {
    if (f.w < 1) { if (!cur) cur = { t0: f.t, list: [] }; cur.list.push(f); }
    else { if (cur && f.t - cur.t0 > 300) holds.push(cur); cur = null; }
  }
  if (cur && cur.list.length && cur.list.at(-1).t - cur.t0 > 300) holds.push(cur);
  console.log(`  held poses (|w|<1 for 0.3 s+): ${holds.length}`);
  for (const h of holds.slice(0, 20)) {
    const L = h.list;
    console.log(`    ${((h.t0 - F[0].t) / 1000).toFixed(1).padStart(6)}s ${((L.at(-1).t - h.t0) / 1000).toFixed(1)}s  cells p50 ${pct(L.map((f) => f.cells), 0.5)}  sharp p50 ${f1(pct(L.map((f) => f.sharp), 0.5))}  bright ${pct(L.map((f) => f.bright), 0.5)}  usable ${f1((100 * L.filter(usable).length) / L.length)}%`);
  }
}

// thumbnails
if (imgs.length) {
  const dir = path.join('recordings', path.basename(file, '.json') + '-cam');
  fs.mkdirSync(dir, { recursive: true });
  const t0 = imgs[0].t;
  imgs.forEach((im, i) => {
    const b64 = String(im.img || '').split(',')[1];
    if (!b64) return;
    const name = `${String(i).padStart(3, '0')}_${((im.t - t0) / 1000).toFixed(1)}s_${im.facing === 'user' ? 'front' : 'rear'}_w${im.w}.jpg`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
  });
  console.log(`\nthumbnails -> ${dir} (${imgs.length})`);
}
