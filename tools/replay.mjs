// Replay a real recording through the controller at physics rate and score the feel:
//   - tremor  : tip jitter while the hand is held still
//   - swing   : how far the shown sword is from where the hand is at screen time (|w| > 3 rad/s)
//   - thrust  : hand translation the accelerometer path produces
//   node tools/replay.mjs [recording] [--compare]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Quaternion, Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';
import { Fusion } from '../public/js/fusion.js';
import { quatAngle } from '../public/js/orient.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const dir = path.join(ROOT, 'recordings');
const file = arg || path.join(dir, fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().pop());
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const S = rec.samples;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN; };
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / Math.max(1, a.length));
const DISPLAY_MS = 30;

// ground truth attitude stream (fused, unpredicted) for "where the hand is"
const truthF = new Fusion();
if (rec.mapping?.confident) truthF.mapping = { ...rec.mapping };
const truth = [];
for (const s of S) { truthF.push({ ...s }); if (truthF.ready) truth.push({ recvT: s.t, q: truthF.q.clone(), w: truthF.w.length() }); }
const truthAt = (t) => {
  let lo = 0, hi = truth.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (truth[m].recvT < t) lo = m; else hi = m; }
  const a = truth[lo], b = truth[hi];
  if (!a || !b || b.recvT === a.recvT) return a?.q;
  return a.q.clone().slerp(b.q, Math.max(0, Math.min(1, (t - a.recvT) / (b.recvT - a.recvT))));
};

function run(setup) {
  const c = new Controller();
  if (rec.mapping?.confident) c.fusion.mapping = { ...rec.mapping };
  else if (rec.mapping?.perm?.join() === '2,0,1') c.fusion.mapping = { ...rec.mapping, confident: true }; // iOS preset
  if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib); // calibration at record time
  setup?.(c);
  const out = { pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3(), dir: new Vector3() };
  const tips = [], swingErr = [], offsets = [];
  let i = 0;
  const t0 = S[0].recv, t1 = S.at(-1).recv;
  for (let t = t0; t < t1; t += 1000 / 240) {
    while (i < S.length && S[i].recv <= t) c.push({ ...S[i++] });
    if (!c.ready) continue;
    c.target(t, out);
    const w = c.fusion.w.length();
    // orientation-only tip (translation offset excluded) isolates tremor
    const tip = c.arm.baseGrip(out.dir, new Vector3()).addScaledVector(out.dir, 1.02);
    tips.push({ t, tip, w });
    offsets.push(c.arm.offset.length());
    if (w > 3) {
      // phone time of "now + display latency" ≈ t - offset; use the controller's clock offset
      const tq = truthAt(t - c.fusion.off + DISPLAY_MS);
      if (tq) swingErr.push((quatAngle(c.calib.swordQuat(tq, new Quaternion()), out.quat) * 180) / Math.PI);
    }
  }
  // tremor: tip deviation from its own 100 ms moving average, only where the whole window is still
  const jit = [];
  const W = 12;
  for (let k = W; k < tips.length - W; k++) {
    let still = true;
    for (let j = k - W; j <= k + W && still; j++) if (tips[j].w > 0.35) still = false;
    if (!still) continue;
    const avg = new Vector3();
    for (let j = k - W; j <= k + W; j++) avg.add(tips[j].tip);
    avg.multiplyScalar(1 / (2 * W + 1));
    jit.push(tips[k].tip.distanceTo(avg) * 1000);
  }
  return {
    '정지 떨림 mm (rms/p95)': `${rms(jit).toFixed(1)} / ${pct(jit, 0.95).toFixed(1)}`,
    '스윙 오차 ° (rms/p95)': `${rms(swingErr).toFixed(1)} / ${pct(swingErr, 0.95).toFixed(1)}`,
    '손 이동 cm (p95/최대)': `${(pct(offsets, 0.95) * 100).toFixed(1)} / ${(Math.max(...offsets) * 100).toFixed(1)}`,
    '정지 중 손 이동 cm p50': (pct(offsets.filter((_, k) => tips[k]?.w < 0.3), 0.5) * 100).toFixed(1),
  };
}

const OLD_ARM = { deadzone: 1.0, gateW0: 2.5, gateW1: 5.5, stillAcc: 0, stillW: 0, tauV: 0.22, tauX: 0.45, maxOffset: 0.42 };
const rows = {};
if (process.argv.includes('--compare')) {
  rows['이전'] = run((c) => {
    c.params.smoothMinHz = 1000;
    Object.assign(c.fusion.params, { predictGateLo: 0, predictGateHi: 0.0001 });
    Object.assign(c.arm.params, OLD_ARM);
  });
}
if (process.argv.includes('--sweep')) {
  for (const smoothMinHz of [1.5, 2, 3]) for (const smoothBeta of [5, 10, 20]) {
    rows[`min ${smoothMinHz}Hz β${smoothBeta}`] = run((c) => Object.assign(c.params, { smoothMinHz, smoothBeta }));
  }
}
rows['현재'] = run();
console.log(`\n# ${path.basename(file)}`);
console.table(rows);
