// Compare accelerometer-translation settings on a thrust recording and a swing recording.
//   node tools/eval-thrust.mjs <thrust-recording> <swing-recording>
import fs from 'node:fs';
import { Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';
import { Q_EW } from '../public/js/orient.js';

const [thrustFile, swingFile] = process.argv.slice(2);
const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const IOS = { perm: [2, 0, 1], sign: [1, 1, 1], scale: Math.PI / 180, confident: true };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };

function series(rec, ctrlParams, armParams) {
  const c = new Controller();
  c.fusion.mapping = { ...IOS };
  c.fusion.accSign = -1;
  if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
  Object.assign(c.params, ctrlParams);
  Object.assign(c.arm.params, armParams);
  const rows = [];
  for (const s of rec.samples) {
    c.push({ ...s });
    if (!c.ready) continue;
    const a = c.fusion.aE.clone().applyQuaternion(Q_EW).applyQuaternion(c.calib.Y);
    rows.push({ t: (s.t - rec.samples[0].t) / 1000, a, w: c.fusion.w.length(), off: c.arm.offset.clone() });
  }
  return rows;
}

function thrustScore(rows) {
  // thrust-outs: accel peaks pointing forward (-z) > 12 m/s²; score forward reach over the next 0.5 s
  const outs = [], backs = [];
  let last = -9;
  for (let i = 1; i < rows.length - 1; i++) {
    const r = rows[i];
    if (r.a.length() < 12 || r.t - last < 0.6) continue;
    const d = r.a.clone().normalize();
    if (d.z < -0.6) { outs.push(i); last = r.t; } else if (d.z > 0.6) { backs.push(i); last = r.t; }
  }
  const reach = outs.map((i) => Math.max(...rows.slice(Math.max(0, i - 15), i + 30).map((r) => -r.off.z)));
  const after = backs.map((i) => (rows[Math.min(rows.length - 1, i + 36)]?.off.length() ?? 0));
  return { reach, after };
}

function swingScore(rows) {
  const rest = rows.filter((r) => r.w < 0.3).map((r) => r.off.length());
  const swing = rows.filter((r) => r.w > 5).map((r) => r.off.length());
  return { restP50: pct(rest, 0.5), restP90: pct(rest, 0.9), swingP95: pct(swing, 0.95) };
}

const T = load(thrustFile), W = load(swingFile);
const variants = {
  'A 단순 차단 (회전 1-3)': [{ bladeGate: false }, { gateW0: 1, gateW1: 3 }],
  '현재 기본값': [{}, {}],
};
for (const ph of [0.3, 0.45]) for (const [b0, b1] of [[4.5, 7.5], [5, 8], [5.5, 8.5]]) {
  variants[`칼날 ${b0}-${b1}, 유지 ${ph}s`] = [{ bladeGate: true }, { gateW0: 1, gateW1: 3, bladeW0: b0, bladeW1: b1, peakHold: ph }];
}
const out = {};
for (const [name, [cp, ap]] of Object.entries(variants)) {
  const t = thrustScore(series(T, cp, ap));
  const s = swingScore(series(W, cp, ap));
  out[name] = {
    '찌르기 도달 cm': t.reach.map((x) => (x * 100).toFixed(0)).join(' '),
    '거둔 뒤 남은 cm': t.after.map((x) => (x * 100).toFixed(0)).join(' '),
    '스윙녹화 정지 p50/p90': `${(s.restP50 * 100).toFixed(1)} / ${(s.restP90 * 100).toFixed(1)}`,
    '스윙 중 가짜 이동 p95': (s.swingP95 * 100).toFixed(1),
  };
}
console.table(out);
