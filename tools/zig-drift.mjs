// How far does ARKit's hand drift away from the body between visits to the guard? At each return to the
// guard (sword still, in the anchoring orientation) the arm-model hand is a good reference: the gap there is
// ARKit drift (+ body moves). Split by what happened since the last guard: low-feature motion ("blind"),
// fast swings, or neither — tells whether the blind rule is protecting against real drift.
//   node tools/zig-drift.mjs [recording]
import fs from 'node:fs';
import path from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';

const file = process.argv[2] || path.join('recordings', fs.readdirSync('recordings').filter((f) => /^rec-.*\.json$/.test(f)).sort().pop());
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const Z = rec.events.filter((e) => e.type === 'zig' && e.d?.sensordata?.quaternion).sort((a, b) => a.recv - b.recv);
const c = new Controller();
if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
if (rec.meta?.stances) c.arm.fromJSON(rec.meta.stances);
const out = { pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3(), dir: new Vector3() };
const H = 1000 / 240;
let i = 0, wasGuard = false, since = null;
const visits = [];
for (let now = Z[0].recv; now < Z.at(-1).recv; now += H) {
  while (i < Z.length && Z[i].recv <= now) {
    const e = Z[i++], s = e.d.sensordata;
    const att = new Quaternion(...s.quaternion).normalize();
    const w = new Vector3(...(s.gyro || [0, 0, 0]));
    const a = new Vector3(...(s.accel || [0, 0, 0])).multiplyScalar(-9.81);
    c.pushAttitude({ t: e.recv, recv: e.recv, q: att, w, a, stickX: 0, stickY: 0, buttons: 0 });
    if (s.arkitposition && s.arkitrotation) c.pushArkit({ t: e.recv, recv: e.recv, pos: s.arkitposition, rot: s.arkitrotation, att, w: w.length(), fp: s.arkitfeaturepoints?.count ?? 0 });
  }
  if (!c.ready) continue;
  c.target(now, out);
  const k = c.arkit;
  if (!k.anchor) continue;
  const t = (now - Z[0].recv) / 1000;
  if (since) {
    since.dur += H / 1000;
    if (k.fp < 12 && (k.w > 1.2 || k.velA.length() > 0.25)) since.blindLow += H / 1000;
    if (k.fp < 12 && (k.w > 3 || k.velA.length() > 0.6)) since.blindFast += H / 1000;
    since.maxW = Math.max(since.maxW, k.w);
    since.minFp = Math.min(since.minFp, k.fp);
    since.maxY = Math.max(since.maxY, k.hand.y);
  }
  if (k.inGuard && !wasGuard && since) {
    // gap at entry: ARKit hand (anchor as it was) vs the arm model's hand
    const model = out.pos.clone().sub(c._arkOff);
    visits.push({ t, gap: k.hand.distanceTo(model), d: k.hand.clone().sub(model), ...since });
  }
  if (!k.inGuard && wasGuard) since = { from: t, dur: 0, blindLow: 0, blindFast: 0, maxW: 0, minFp: 999, maxY: 0 };
  wasGuard = k.inGuard;
}
const cm = (v) => `(${(v.x * 100).toFixed(0)},${(v.y * 100).toFixed(0)},${(v.z * 100).toFixed(0)})`;
console.log(`${path.basename(file)}: ${visits.length} returns to the guard`);
console.log('  left  back   away | gap cm (x,y,z)      | low-fp moving s (any / fast) | max w | min fp | max hand y');
for (const v of visits) console.log(`  ${v.from.toFixed(1).padStart(5)} ${v.t.toFixed(1).padStart(5)} ${v.dur.toFixed(1).padStart(5)} | ${(v.gap * 100).toFixed(0).padStart(3)} ${cm(v.d).padEnd(15)} | ${v.blindLow.toFixed(2).padStart(5)} / ${v.blindFast.toFixed(2).padStart(5)} | ${v.maxW.toFixed(1).padStart(5)} | ${String(v.minFp).padStart(4)} | ${v.maxY.toFixed(2)}`);
