// What the player actually sees jump: the PHYSICS sword (force-limited servo, which filters the target)
// driven by a real recording at its real arrival times, through the whole controller (fusion, tremor
// filter, hand model). Compared with the phone's true rotation speed (samples fused without network).
//   rot jumps : steps where the drawn blade turns much faster than the phone did
//   tip jumps : steps where the blade tip moves much faster than the phone's rotation can explain
//   node tools/physjumps.mjs <recording> ['{"fusion":{...},"ctrl":{...}}' ...]
//   node tools/physjumps.mjs <recording> --trace <t0> <t1>      per-step trace of target and body
import fs from 'node:fs';
import path from 'node:path';
import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';
import { Fusion } from '../public/js/fusion.js';
import { SwordController } from '../public/js/swordctl.js';
import { swordColliders, SWORD } from '../public/js/sword.js';
import { quatAngle } from '../public/js/orient.js';

await RAPIER.init();
const [file, ...rest] = process.argv.slice(2);
const TRACE = rest[0] === '--trace' ? [+rest[1], +rest[2]] : null;
const variants = TRACE ? [] : rest;
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const S = rec.samples;
const IOS = { perm: [2, 0, 1], sign: [1, 1, 1], scale: Math.PI / 180, confident: true };
const D = 180 / Math.PI, H = 1 / 240;

// true phone rotation speed by phone time (instant arrival)
const offMin = Math.min(...S.map((s) => s.recv - s.t));
const truth = [];
{
  const f = new Fusion(); f.mapping = { ...IOS }; f.accSign = -1; f.params.autoMap = false;
  for (const s of S) { f.push({ ...s, recv: s.t + offMin }); if (f.ready) truth.push({ t: s.t, w: f.w.length() }); }
}
function wTrueAt(t) {
  let lo = 0, hi = truth.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (truth[m].t < t) lo = m; else hi = m; }
  return Math.max(truth[lo].w, truth[hi].w);
}

function run(opts = {}) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = H;
  world.numSolverIterations = 8;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0.04, 1.1, -0.42).setCcdEnabled(true).setCanSleep(false));
  for (const d of Object.values(swordColliders(RAPIER))) world.createCollider(d, body);
  const sc = new SwordController(RAPIER, world, body);
  const c = new Controller();
  c.fusion.mapping = { ...IOS }; c.fusion.accSign = -1; c.fusion.params.autoMap = false;
  if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
  if (rec.meta?.stances) c.arm.fromJSON(rec.meta.stances);
  Object.assign(c.fusion.params, opts.fusion || {});
  Object.assign(c.params, opts.ctrl || {});
  Object.assign(sc.params, opts.sword || {});
  const tgt = { pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3(), dir: new Vector3() };
  const qPrev = new Quaternion(), tipPrev = new Vector3(), q = new Quaternion(), tip = new Vector3();
  const qtPrev = new Quaternion();
  let i = 0, started = false, has = false, lastRecv = 0, nTrace = 0;
  const ev = { rot: [], tip: [], tgt: [] };
  for (let now = S[0].recv; now < S.at(-1).recv; now += H * 1000) {
    let arrived = 0;
    while (i < S.length && S[i].recv <= now) { c.push({ ...S[i++] }); arrived++; lastRecv = now; }
    if (!c.ready) continue;
    c.target(now, tgt);
    if (!started) { sc.teleport(tgt.pos, tgt.quat); started = true; }
    sc.target.pos.copy(tgt.pos); sc.target.quat.copy(tgt.quat); sc.target.w.copy(tgt.w); sc.target.v.copy(tgt.v);
    const rescued = sc.step(H, -9.81);
    world.step();
    if (TRACE) {
      const t = (now - S[0].recv) / 1000;
      if (t >= TRACE[0] && t <= TRACE[1] && (nTrace++ % 3 === 0 || rescued)) {
        const tr = body.translation(), f2 = (a) => a.map((x) => x.toFixed(2)).join(',');
        console.log(`${t.toFixed(3)} +${arrived} stale ${String((now - lastRecv).toFixed(0)).padStart(3)}ms |w| ${c.fusion.w.length().toFixed(1).padStart(4)}  target(${f2(tgt.pos.toArray())}) body(${f2([tr.x, tr.y, tr.z])}) dir(${f2(tgt.dir.toArray())}) offset ${c.arm.offset.length().toFixed(2)} inv ${c.involvement.toFixed(2)}${rescued ? '  RESCUE' : ''}`);
      }
    }
    const r = body.rotation(), tr = body.translation();
    q.set(r.x, r.y, r.z, r.w);
    tip.set(0, SWORD.tip, 0).applyQuaternion(q).add(new Vector3(tr.x, tr.y, tr.z));
    if (has) {
      const t = (now - S[0].recv) / 1000;
      const wTrue = wTrueAt(now - offMin + c.fusion.params.predictMs);
      const lim = 1.6 * wTrue + 3; // rad/s
      const w = quatAngle(q, qPrev) / H;
      if (w > lim) ev.rot.push({ t, deg: (w - lim) * H * D });
      const wt = quatAngle(tgt.quat, qtPrev) / H;
      if (wt > lim) ev.tgt.push({ t, deg: (wt - lim) * H * D });
      // tip: rotation explains |w|·1 m; allow that plus 1.5 m/s of hand motion
      const vTip = tip.distanceTo(tipPrev) / H, vLim = lim * 1.0 + 1.5;
      if (vTip > vLim) ev.tip.push({ t, cm: (vTip - vLim) * H * 100 });
    }
    qPrev.copy(q); tipPrev.copy(tip); qtPrev.copy(tgt.quat); has = true;
  }
  const minutes = (S.at(-1).recv - S[0].recv) / 60000;
  const group = (list, key, min) => {
    const out = [];
    for (const j of list) { const e = out.at(-1); if (e && j.t - e.t1 < 0.03) { e.t1 = j.t; e.v += j[key]; } else out.push({ t0: j.t, t1: j.t, v: j[key] }); }
    return out.filter((e) => e.v > min);
  };
  const rot = group(ev.rot, 'deg', 3), tipE = group(ev.tip, 'cm', 2), tg = group(ev.tgt, 'deg', 3);
  return {
    tgtPerMin: tg.length / minutes,
    rotPerMin: rot.length / minutes, rotDegPerMin: rot.reduce((a, e) => a + e.v, 0) / minutes,
    tipPerMin: tipE.length / minutes, tipCmPerMin: tipE.reduce((a, e) => a + e.v, 0) / minutes,
    worstRot: rot.sort((a, b) => b.v - a.v).slice(0, 4).map((e) => `${e.t0.toFixed(2)}s ${e.v.toFixed(0)}°`),
    worstTip: tipE.sort((a, b) => b.v - a.v).slice(0, 4).map((e) => `${e.t0.toFixed(2)}s ${e.v.toFixed(0)}cm`),
  };
}

console.log(path.basename(file), `${((S.at(-1).recv - S[0].recv) / 1000).toFixed(0)} s`);
if (TRACE) { run(); process.exit(0); }
for (const v of ['{}', ...variants]) {
  const r = run(JSON.parse(v));
  console.log(`${v.padEnd(60)} target jumps ${r.tgtPerMin.toFixed(0)}/min | DRAWN blade: turn jumps ${r.rotPerMin.toFixed(1)}/min (${r.rotDegPerMin.toFixed(0)}°/min) tip jumps ${r.tipPerMin.toFixed(1)}/min (${r.tipCmPerMin.toFixed(0)}cm/min) | worst ${r.worstRot.join(', ')} | ${r.worstTip.join(', ')}`);
}
