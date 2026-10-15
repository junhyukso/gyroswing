// Drive the physical sword with a real recording and measure per-swing cutting energy on the
// physics body (what the game actually judges), next to the target-based estimate.
//   node tools/physics-replay.mjs <recording> [cutEnergy]
import fs from 'node:fs';
import path from 'node:path';
import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';
import { SwordController } from '../public/js/swordctl.js';
import { swordColliders } from '../public/js/sword.js';

await RAPIER.init();
const file = process.argv[2];
const E_REQ = Number(process.argv[3] || 40);
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const H = 1 / 240;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = H;
world.numSolverIterations = 8;
const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0.04, 1.1, -0.42).setCcdEnabled(true).setCanSleep(false));
for (const d of Object.values(swordColliders(RAPIER))) world.createCollider(d, body);
const sc = new SwordController(RAPIER, world, body);
const c = new Controller();
c.fusion.mapping = { perm: [2, 0, 1], sign: [1, 1, 1], scale: Math.PI / 180, confident: true }; c.fusion.accSign = -1;
if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
const P = { mWrist: 0.35, mArm: 1.5 };
const tgt = { pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3(), dir: new Vector3() };
const S = rec.samples;
let i = 0;
const swings = [];
let cur = null;
let started = false;
for (let t = S[0].recv; t < S.at(-1).recv; t += H * 1000) {
  while (i < S.length && S[i].recv <= t) c.push({ ...S[i++] });
  if (!c.ready) continue;
  c.target(t, tgt);
  if (!started) { sc.teleport(tgt.pos, tgt.quat); started = true; }
  sc.target.pos.copy(tgt.pos); sc.target.quat.copy(tgt.quat); sc.target.w.copy(tgt.w); sc.target.v.copy(tgt.v);
  sc.step(H, -9.81);
  world.step();
  const m = P.mWrist + (P.mArm - P.mWrist) * c.involvement;
  // physics body speed across the blade at 0.75 m
  const r = body.rotation(), q = new Quaternion(r.x, r.y, r.z, r.w);
  const tr = body.translation(), cm = body.worldCom(), lv = body.linvel(), av = body.angvel();
  const b = new Vector3(0, 1, 0).applyQuaternion(q);
  const pz = new Vector3(tr.x, tr.y, tr.z).addScaledVector(b, 0.75);
  const v = new Vector3(av.x, av.y, av.z).cross(pz.sub(new Vector3(cm.x, cm.y, cm.z))).add(new Vector3(lv.x, lv.y, lv.z));
  const sp = v.addScaledVector(b, -v.dot(b)).length();
  // target estimate at the same point
  const vt = tgt.v.clone().add(new Vector3().crossVectors(tgt.w, tgt.dir.clone().multiplyScalar(0.75)));
  const spT = vt.addScaledVector(tgt.dir, -vt.dot(tgt.dir)).length();
  if (c.fusion.w.length() > 5) {
    if (!cur) cur = { e: 0, eT: 0 };
    cur.e = Math.max(cur.e, 0.5 * m * sp * sp);
    cur.eT = Math.max(cur.eT, 0.5 * m * spT * spT);
  } else if (cur) { swings.push(cur); cur = null; }
}
const n = (k) => swings.filter((s) => s[k] >= E_REQ).length;
console.log(`# ${path.basename(file)}: ${swings.length} swings`);
console.log(`>= ${E_REQ} J  target-based ${n('eT')}  physics-body ${n('e')}`);
const ratios = swings.filter((s) => s.eT > 5).map((s) => s.e / s.eT).sort((a, b) => a - b);
console.log(`physics/target energy ratio: p50 ${ratios[ratios.length >> 1]?.toFixed(2)}  p90 ${ratios[Math.floor(ratios.length * 0.9)]?.toFixed(2)}`);
console.log('physics energies:', swings.map((s) => s.e.toFixed(0)).join(' '));
