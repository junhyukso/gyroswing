// Replay a ZIG SIM recording through the controller (Core Motion attitude + ARKit hand), the way the
// game's ZIG mode feeds it, at physics rate: when is ARKit trusted, where does it put the hand in held
// poses compared with the arm model alone, and does the hand jump when trust comes and goes.
//   node tools/zig-replay.mjs [recording] [--timeline] [--recenter] [--hint] [--set=blindAfter=0,reachMin=0]
//   (the recording's calibration is used as is; --recenter re-centres the heading at the first still guard,
//    for recordings made before ZIG mode had its own heading calibration)
import fs from 'node:fs';
import path from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';
import { CHEST } from '../public/js/armmodel.js';

const args = process.argv.slice(2);
const arg = args.find((a) => !a.startsWith('--'));
const file = arg || path.join('recordings', fs.readdirSync('recordings').filter((f) => /^rec-.*\.json$/.test(f)).sort().pop());
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const Z = rec.events.filter((e) => e.type === 'zig' && e.d?.sensordata?.quaternion).sort((a, b) => a.recv - b.recv);
// drill attacks: { key, recv (start), end (result) }
const drill = [];
for (const e of rec.events.filter((x) => x.type === 'drill')) { if (e.ev === 'attack') drill.push({ key: e.key, level: e.level, recv: e.recv, end: e.recv + 3000, line: '' }); else if (drill.length) Object.assign(drill.at(-1), { end: e.recv, line: e.line }); }
const cm = (v) => `(${(v.x * 100).toFixed(0)},${(v.y * 100).toFixed(0)},${(v.z * 100).toFixed(0)})`;

const c = new Controller();
if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
if (rec.meta?.stances) c.arm.fromJSON(rec.meta.stances);
// --set=key=value,...: override ARKit params (tuning)
for (const kv of (args.find((a) => a.startsWith('--set='))?.slice(6) ?? '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); c.arkit.params[k] = Number(v); }
const out = { pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3(), dir: new Vector3() };

let anchoredAt = null;
let i = 0, recentered = false, stillFor = 0, maxBlockW = 0, maxGuard = 0, offN = 0, allN = 0;
const rows = [];
const H = 1000 / 240;
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
  // heading: the ZIG reference frame has its own yaw — re-centre once at the first still guard (like Space)
  stillFor = c.fusion.w.length() < 0.4 ? stillFor + H / 1000 : 0;
  if (args.includes('--recenter') && !recentered && stillFor > 0.8) { c.calib.recenter(c.fusion.q); recentered = true; }
  // drill attacks in the recording: tell the controller like the game does (wind-up .. result)
  const att = drill.find((a) => now >= a.recv && now <= a.end);
  if (!args.includes('--hint')) c.blockHint = att ? { y: att.key === 'overhead' ? 1.75 : /diag/.test(att.key) ? 1.65 : att.key === 'thrust' ? 1.1 : 1.0, side: /diagR|horizR/.test(att.key) ? -1 : /diagL|horizL/.test(att.key) ? 1 : 0 } : null;
  if (args.includes('--hint')) c.blockHint = { y: 1.0, side: 1 }; // an attack always coming: block assists would act
  c.target(now, out);
  if (args.includes('--hint') && c.arkit.anchor && (anchoredAt ??= now) && now - anchoredAt > 500) { maxBlockW = Math.max(maxBlockW, c.blockW); maxGuard = Math.max(maxGuard, c._guardOn); offN += c.assistsOff ? 1 : 0; allN++; }
  rows.push({ t: (now - Z[0].recv) / 1000, pos: out.pos.clone(), off: c._arkOff.clone(), trust: c.arkit.trust, valid: c.arkit.valid, fp: c.arkit.fp, w: c.fusion.w.length(), anchored: !!c.arkit.anchor, dir: out.dir.clone(), speed: c.arkit.velA.length(), why: (now < c.arkit.blindUntil ? 'B' : '') + (c.arkit.needSteady ? 'S' : '') + (now < c.arkit.swingUntil ? 'W' : '') + (now < c.arkit.jumpUntil ? 'J' : '') + (c.arkit.anchor && (c.arkit.hand.distanceTo(CHEST) >= c.arkit.params.reach || c.arkit.hand.distanceTo(CHEST) <= c.arkit.params.reachMin) ? 'R' : '') + (c.arkit.inGuard ? 'G' : ''), reachD: c.arkit.anchor ? c.arkit.hand.distanceTo(CHEST) : 0, arkY: c.arkit.anchor ? c.arkit.hand.y : 0, guardFor: c.arkit.inGuard ? 1 : 0, gAng: c.arkit.guardQ ? out.quat.angleTo(c.arkit.guardQ) * 57.3 : -1 });
}

const dur = rows.at(-1).t;
const trusted = rows.filter((r) => r.trust > 0.5);
const slow = rows.filter((r) => r.w < 1), fast = rows.filter((r) => r.w > 4);
console.log(`${path.basename(file)} · ${dur.toFixed(1)} s · anchored at ${rows.find((r) => r.anchored)?.t.toFixed(1) ?? 'never'} s`);
console.log(`ARKit trusted (>0.5): ${(100 * trusted.length / rows.length).toFixed(0)}% of the time | while slow (<1 rad/s) ${(100 * slow.filter((r) => r.trust > 0.5).length / slow.length).toFixed(0)}% | while swinging (>4 rad/s) ${(100 * fast.filter((r) => r.trust > 0.5).length / Math.max(1, fast.length)).toFixed(0)}%`);
const high = rows.filter((r) => r.anchored && r.arkY > 1.15 && r.w < 4);
const seg = args.find((a) => a.startsWith('--seg='))?.slice(6).split('-').map(Number);
if (seg) { const S = rows.filter((r) => r.t >= seg[0] && r.t <= seg[1]); console.log(`  ${seg[0]}–${seg[1]} s: trusted ${(100 * S.filter((r) => r.trust > 0.5).length / Math.max(1, S.length)).toFixed(0)}%`); }
const trustedOff = trusted.map((r) => r.off.length()).sort((a, b) => a - b);
console.log(`  hand high (ARKit y > 1.15 m, not swinging): trusted ${(100 * high.filter((r) => r.trust > 0.5).length / Math.max(1, high.length)).toFixed(0)}% of ${(high.length * H / 1000).toFixed(1)} s | offset while trusted: p50 ${((trustedOff[trustedOff.length >> 1] ?? 0) * 100).toFixed(0)} p95 ${((trustedOff[Math.floor(trustedOff.length * 0.95)] ?? 0) * 100).toFixed(0)} max ${((trustedOff.at(-1) ?? 0) * 100).toFixed(0)} cm`);

// held poses: final hand vs arm model (= final - offset)
const holds = [];
let cur = null;
for (const r of rows) {
  if (r.w < 0.8) { if (!cur) cur = []; cur.push(r); }
  else { if (cur && cur.at(-1).t - cur[0].t > 0.5) holds.push(cur); cur = null; }
}
if (cur && cur.at(-1).t - cur[0].t > 0.5) holds.push(cur);
console.log('\nheld poses: blade dir | hand with ARKit | arm model alone | ARKit offset | trust');
for (const L of holds) {
  const m = L[Math.floor(L.length * 0.7)];
  const model = m.pos.clone().sub(m.off);
  console.log(`  ${L[0].t.toFixed(1).padStart(5)}s  dir ${cm(m.dir).padEnd(14)} hand ${cm(m.pos).padEnd(14)} model ${cm(model).padEnd(14)} offset ${(m.off.length() * 100).toFixed(0).padStart(3)} cm  trust ${m.trust.toFixed(2)}  fp ${m.fp}`);
}

// smoothness: hand speed spikes caused by the ARKit offset itself (offset change per step)
const offRates = rows.slice(1).map((r, k) => r.off.distanceTo(rows[k].off) / (H / 1000)).sort((a, b) => a - b);
console.log(`\nARKit offset rate of change m/s: p50 ${offRates[offRates.length >> 1].toFixed(2)} p99 ${offRates[Math.floor(offRates.length * 0.99)].toFixed(2)} max ${offRates.at(-1).toFixed(2)}`);
if (args.includes('--timeline')) { const from = +(args.find((a) => a.startsWith('--from='))?.slice(7) ?? 0); for (let k = 0; k < rows.length; k += 24) { const r = rows[k]; if (r.t < from) continue; console.log(`${r.t.toFixed(1).padStart(5)} w ${r.w.toFixed(1).padStart(4)} fp ${String(r.fp).padStart(3)} spd ${r.speed.toFixed(2)} ${(r.why || '-').padEnd(3)} reach ${r.reachD.toFixed(2)} arkY ${r.arkY.toFixed(2)} trust ${r.trust.toFixed(2)} off ${cm(r.off)} hand ${cm(r.pos)} dir ${cm(r.dir)}`); } }
if (args.includes('--hint')) console.log(`
with an attack always coming: assists off ${(100 * offN / Math.max(1, allN)).toFixed(0)}% of the anchored time, max block-pose weight ${maxBlockW.toFixed(2)}, max guard-layer weight ${maxGuard.toFixed(2)}`);
// per attack: where the hand was at the strike (wind-up 0.95 s at level 1) and a bit into it
if (drill.length) {
  console.log('\nattacks: at strike start / +0.2 s — hand (with ARKit) | arm model | trust | guard');
  for (const a of drill) {
    const at = (dt) => rows.reduce((b, r) => (Math.abs(r.t - ((a.recv - Z[0].recv) / 1000 + dt)) < Math.abs(b.t - ((a.recv - Z[0].recv) / 1000 + dt)) ? r : b), rows[0]);
    const s0 = at(0.95), s1 = at(1.15);
    const f = (r) => `hand ${cm(r.pos).padEnd(14)} model ${cm(r.pos.clone().sub(r.off)).padEnd(14)} trust ${r.trust.toFixed(2)} ${r.guardFor ? 'G' : ' '} w ${r.w.toFixed(1)}`;
    console.log(`  ${((a.recv - Z[0].recv) / 1000).toFixed(1).padStart(5)}s ${a.key.padEnd(8)} ${f(s0)}  |  ${f(s1)}  -> ${a.line.slice(0, 22)}`);
  }
}
