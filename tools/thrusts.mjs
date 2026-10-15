// Find thrust-like moves in a recording and show what the accelerometer path made of them.
//   node tools/thrusts.mjs [recording]
import fs from 'node:fs';
import path from 'node:path';
import { Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';
import { Q_EW } from '../public/js/orient.js';

const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const file = arg || path.join('recordings', fs.readdirSync('recordings').filter((f) => f.endsWith('.json')).sort().pop());
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const IOS = { perm: [2, 0, 1], sign: [1, 1, 1], scale: Math.PI / 180, confident: true };

export function series(params = {}) {
  const c = new Controller();
  c.fusion.mapping = { ...IOS };
  c.fusion.accSign = -1;
  if (rec.meta?.calib) { c.calib.fromJSON(rec.meta.calib); c.calib.headingCalibrated = true; } // calibration at record time
  Object.assign(c.arm.params, params);
  const rows = [];
  for (const s of rec.samples) {
    c.push({ ...s });
    if (!c.ready) continue;
    const a = c.fusion.aE.clone().applyQuaternion(Q_EW).applyQuaternion(c.calib.Y); // body frame
    const dir = new Vector3(0, 1, 0).applyQuaternion(c.calib.swordQuat(c.fusion.q, new (c.fusion.q.constructor)()));
    rows.push({ t: (s.t - rec.samples[0].t) / 1000, a, w: c.fusion.w.length(), off: c.arm.offset.clone(), dir });
  }
  return rows;
}

const base = series();
const open = series({ gateW0: 100, gateW1: 101 }); // no rotation gate
// events: local peaks of |a| above 6 m/s², at least 0.35 s apart
const ev = [];
for (let i = 2; i < base.length - 2; i++) {
  const m = base[i].a.length();
  if (m < 6 || m < base[i - 1].a.length() || m < base[i + 1].a.length()) continue;
  if (ev.length && base[i].t - base[ev.at(-1)].t < 0.35) { if (m > base[ev.at(-1)].a.length()) ev[ev.length - 1] = i; continue; }
  ev.push(i);
}
console.log(`# ${path.basename(file)}: ${ev.length} strong accel events (|a| > 6 m/s²)`);
const f = (v) => `${v.x >= 0 ? ' ' : ''}${v.x.toFixed(1)},${v.y >= 0 ? ' ' : ''}${v.y.toFixed(1)},${v.z >= 0 ? ' ' : ''}${v.z.toFixed(1)}`;
const rows = ev.map((i) => {
  const win = base.slice(Math.max(0, i - 12), Math.min(base.length, i + 24));
  const peak = (arr) => Math.max(...arr.slice(Math.max(0, i - 12), Math.min(arr.length, i + 30)).map((r) => r.off.length()));
  const wMax = Math.max(...win.map((r) => r.w));
  const wMed = win.map((r) => r.w).sort((x, y) => x - y)[win.length >> 1];
  const ad = base[i].a.clone().normalize();
  return {
    t: base[i].t.toFixed(2), '|a|': base[i].a.length().toFixed(1), 'a dir (body x,y,z)': f(ad),
    'a·blade': ad.dot(base[i].dir).toFixed(2), 'w med/max': `${wMed.toFixed(1)}/${wMax.toFixed(1)}`,
    'offset cm now': (peak(base) * 100).toFixed(1), 'offset cm no gate': (peak(open) * 100).toFixed(1),
  };
});
console.table(rows);
