import fs from 'node:fs';
import { Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';
import { ArmModel } from '../public/js/armmodel.js';
const f = fs.readdirSync('recordings').sort().pop();
const rec = JSON.parse(fs.readFileSync('recordings/' + f));
const smooth = (x) => x * x * x * (x * (x * 6 - 15) + 10);
function synthThrust(params) {
  const a = new ArmModel(); Object.assign(a.params, params);
  const dt = 1 / 60, pos = (t) => 0.3 * smooth(Math.min(1, Math.max(0, t / 0.3)));
  let peak = 0;
  for (let i = 0; i < 90; i++) { const t = i * dt; a.integrate(new Vector3(0, 0, -(pos(t + dt) - 2 * pos(t) + pos(t - dt)) / (dt * dt)), 0.3, dt); peak = Math.max(peak, -a.offset.z); }
  return peak;
}
function real(params) {
  const c = new Controller(); c.fusion.mapping = { ...rec.mapping }; Object.assign(c.arm.params, params);
  const rows = [];
  for (const s of rec.samples) { c.push({ ...s }); if (c.ready) rows.push({ w: c.fusion.w.length(), a: c.fusion.aE.length(), off: c.arm.offset.length() }); }
  const rest = rows.filter((r) => r.w < 0.3).map((r) => r.off).sort((x, y) => x - y);
  // thrust-like events: |a| > 8 with |w| < 2.5 -> peak offset in the next 0.5 s
  const peaks = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].a > 8 && rows[i].w < 2.5) { let pk = 0; for (let j = i; j < Math.min(rows.length, i + 30); j++) pk = Math.max(pk, rows[j].off); peaks.push(pk); i += 30; }
  }
  return { restP50: rest[rest.length >> 1], restP90: rest[Math.floor(rest.length * 0.9)], eventPeak: peaks.reduce((s, x) => s + x, 0) / Math.max(1, peaks.length), events: peaks.length };
}
const out = [];
for (const [gateW0, gateW1] of [[3, 7], [1.5, 4], [1, 3], [0.8, 2.2]]) {
  for (const tauX of [0.6, 0.9]) {
    for (const tauV of [0.5, 1.5]) {
      for (const alwaysDecay of [false, true]) {
        const p = { gateW0, gateW1, tauX, tauV, alwaysDecay };
        const r = real(p);
        out.push({ gate: `${gateW0}-${gateW1}`, tauX, tauV, alwaysDecay, 'rest p50 cm': +(r.restP50 * 100).toFixed(1), 'rest p90 cm': +(r.restP90 * 100).toFixed(1), 'event peak cm': +(r.eventPeak * 100).toFixed(1), 'synth 30cm': +(synthThrust(p) * 100).toFixed(1) });
      }
    }
  }
}
console.table(out);
