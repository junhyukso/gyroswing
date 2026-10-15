// Analyze a sensor recording (F9 in game -> recordings/*.json) and evaluate predictor settings
// on real data. Ground truth for prediction = the fused attitude observed later in the recording.
//   node tools/analyze.mjs                      newest recording
//   node tools/analyze.mjs recordings/x.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Quaternion, Vector3 } from 'three';
import { Fusion } from '../public/js/fusion.js';
import { quatAngle } from '../public/js/orient.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const deg = (r) => (r * 180) / Math.PI;
const pct = (arr, p) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f1 = (x) => (Number.isFinite(x) ? +x.toFixed(1) : x);

function pickFile() {
  const a = process.argv.slice(2).find((x) => !x.startsWith('--'));
  if (a) return a;
  const dir = path.join(ROOT, 'recordings');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f));
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!files.length) throw new Error('no recordings');
  return files[0];
}

const file = pickFile();
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const S = rec.samples;
console.log(`\n# ${path.basename(file)}  (${S.length} samples, ${((S.at(-1).t - S[0].t) / 1000).toFixed(1)} s)`);
if (rec.meta?.params) console.log('game params at record time:', JSON.stringify(rec.meta.params.fusion));

// ---------------------------------------------------------------- timing & network
const iv = [], lagRaw = [];
let gaps = 0, lost = 0;
for (let i = 1; i < S.length; i++) {
  const d = S[i].t - S[i - 1].t;
  iv.push(d);
  if (d > 50) gaps++;
  const g = (S[i].seq - S[i - 1].seq + 65536) & 0xffff;
  if (g > 1 && g < 1000) lost += g - 1;
}
const offMin = Math.min(...S.map((s) => s.recv - s.t));
for (const s of S) lagRaw.push(s.recv - s.t - offMin);
console.log('\n## 센서 / 네트워크');
console.table({
  '샘플 간격 ms': { p50: f1(pct(iv, 0.5)), p95: f1(pct(iv, 0.95)), max: f1(Math.max(...iv)) },
  '추가 지연 ms (최소 대비)': { p50: f1(pct(lagRaw, 0.5)), p95: f1(pct(lagRaw, 0.95)), max: f1(Math.max(...lagRaw)) },
});
console.log(`평균 ${f1(1000 / (iv.reduce((a, b) => a + b, 0) / iv.length))} Hz · 50ms 넘는 공백 ${gaps}회 · 손실 패킷 ${lost} · 자세 없는 샘플 ${S.filter((s) => !(s.flags & 1)).length}`);
const oriAges = S.map((s) => s.oriAge);
console.log(`orientation age ms: p50 ${f1(pct(oriAges, 0.5))}, min ${f1(Math.min(...oriAges))}, max ${f1(Math.max(...oriAges))}`);
const ivRaw = S.map((s) => s.interval);
console.log(`event.interval raw: p50 ${pct(ivRaw, 0.5)} (iOS가 초 단위면 0.0x, ms면 1x)`);

// ---------------------------------------------------------------- fusion pass
// --known-map: start from the mapping the game had confirmed (what a returning device will do)
const KNOWN = process.argv.includes('--known-map') && rec.mapping?.confident ? { ...rec.mapping } : null;
const newFusion = () => { const f = new Fusion(); if (KNOWN) f.mapping = { ...KNOWN }; return f; };
if (KNOWN) console.log(`\n(시작부터 확인된 자이로 매핑 사용: ${JSON.stringify(KNOWN.perm)})`);
const base = newFusion();
const fused = [];
for (const s of S) {
  base.push({ ...s });
  if (base.ready) fused.push({ t: s.t, q: base.q.clone(), w: base.w.clone(), wDot: base.wDot.clone(), aE: base.aE.clone() });
}
const wMag = fused.map((x) => x.w.length());
console.log('\n## 자세 융합');
console.log(`융합 오차(자이로 예측 vs iOS 자세) 평균 ${f1(base.stats.errDeg)}° · 튐 판정 ${base.stats.glitches}회`);
console.log(`자이로 축 매핑: perm [${base.mapping.perm}] sign [${base.mapping.sign}] ${base.mapping.scale === 1 ? 'rad/s' : 'deg/s'} · ${base.mapping.confident ? '확인됨' : '미확인'} (err ${base.mapping.err?.toFixed(3)})`);
console.log(`중력 부호: ${base.accSign}  (녹화 당시 게임: mapping ${JSON.stringify(rec.mapping?.perm)} accSign ${rec.accSign})`);
console.log(`각속도 rad/s: p50 ${f1(pct(wMag, 0.5))}, p95 ${f1(pct(wMag, 0.95))}, max ${f1(Math.max(...wMag))}`);

// swings: contiguous segments with |w| > 5 rad/s
const swings = [];
let cur = null;
for (const x of fused) {
  const m = x.w.length();
  if (m > 5) { if (!cur) cur = { t0: x.t, peak: 0, n: 0 }; cur.peak = Math.max(cur.peak, m); cur.n++; cur.t1 = x.t; }
  else if (cur) { swings.push(cur); cur = null; }
}
console.log(`휘두르기 ${swings.length}회 · 최고 각속도 평균 ${f1(swings.reduce((a, s) => a + s.peak, 0) / Math.max(1, swings.length))} rad/s · 지속 평균 ${f1(swings.reduce((a, s) => a + (s.t1 - s.t0), 0) / Math.max(1, swings.length))} ms`);
const linA = fused.map((x) => x.aE.length());
console.log(`선가속도(중력 제거) m/s²: p95 ${f1(pct(linA, 0.95))}, max ${f1(Math.max(...linA))}`);

// ---------------------------------------------------------------- predictor evaluation
// For each sample, predict the attitude d ms ahead from data available then, and compare with the
// fused attitude actually observed at that time.
function evalPredictor(params, horizons) {
  const f = newFusion();
  Object.assign(f.params, params, { predictMs: 0 });
  const res = Object.fromEntries(horizons.map((h) => [h, { all: [], swing: [] }]));
  const out = new Quaternion();
  let j = 0;
  for (let i = 0; i < S.length; i++) {
    f.push({ ...S[i] });
    if (!f.ready) continue;
    const moving = f.w.length() > 3;
    for (const h of horizons) {
      const tt = S[i].t + h;
      while (j < fused.length - 1 && fused[j].t < tt) j++;
      // find the fused sample nearest to tt
      let k = j;
      while (k > 0 && Math.abs(fused[k - 1].t - tt) < Math.abs(fused[k].t - tt)) k--;
      if (Math.abs(fused[k].t - tt) > 6) continue;
      f.poseAt(f.tLast + f.off + h, out);
      const e = deg(quatAngle(out, fused[k].q));
      res[h].all.push(e);
      if (moving) res[h].swing.push(e);
    }
    j = Math.max(0, j - 8);
  }
  return res;
}

const horizons = [17, 33, 50];
const variants = {
  '1차(각속도)': { stopAware: false },
  '멈춤 인지': { stopAware: true },
};
console.log('\n## 예측 오차 (°, 휘두르는 중 |ω|>3)  — 실제 지연을 감추려면 이만큼 앞을 예측해야 함');
const rows = {};
for (const [name, p] of Object.entries(variants)) {
  const r = evalPredictor(p, horizons);
  for (const h of horizons) {
    rows[`${name} +${h}ms`] = { rms: f1(Math.sqrt(r[h].swing.reduce((a, e) => a + e * e, 0) / Math.max(1, r[h].swing.length))), p95: f1(pct(r[h].swing, 0.95)), 정지포함p50: f1(pct(r[h].all, 0.5)) };
  }
}
// "no prediction" baseline: how far the pose moves in h ms
for (const h of horizons) {
  const e = [];
  let k = 0;
  for (let i = 0; i < fused.length; i++) {
    while (k < fused.length - 1 && fused[k].t < fused[i].t + h) k++;
    if (Math.abs(fused[k].t - fused[i].t - h) < 6 && fused[i].w.length() > 3) e.push(deg(quatAngle(fused[i].q, fused[k].q)));
  }
  rows[`예측 없음 +${h}ms`] = { rms: f1(Math.sqrt(e.reduce((a, x) => a + x * x, 0) / Math.max(1, e.length))), p95: f1(pct(e, 0.95)), 정지포함p50: '' };
}
console.table(rows);

// ---------------------------------------------------------------- events
const ev = rec.events || [];
const counts = {};
for (const e of ev) { const k = e.type === 'btn' ? `btn:${e.name}${e.down === false ? ':up' : ''}` : e.type; counts[k] = (counts[k] || 0) + 1; }
if (ev.length) { console.log('\n## 폰 이벤트'); console.log(counts); }
