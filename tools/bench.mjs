// Deterministic end-to-end bench: simulated phone -> network -> fusion -> calibration -> arm model
// -> physics sword. Measures how far the virtual sword is from where the player's hand actually is.
//   node tools/bench.mjs                 default parameters
//   node tools/bench.mjs sweep           parameter sweep
import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';
import { SimPhone } from '../public/js/sim.js';
import { SwordController } from '../public/js/swordctl.js';
import { swordColliders, SWORD } from '../public/js/sword.js';
import { quatAngle } from '../public/js/orient.js';

await RAPIER.init();
const H = 1 / 240;
const deg = (r) => (r * 180) / Math.PI;

function run(opts = {}) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = H;
  world.numSolverIterations = 8;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0.04, 1.1, -0.42).setCcdEnabled(true).setCanSleep(false));
  for (const d of Object.values(swordColliders(RAPIER))) world.createCollider(d, body);
  const sc = new SwordController(RAPIER, world, body);
  Object.assign(sc.params, opts.sword || {});

  let now = 1000;
  const ctrl = new Controller();
  Object.assign(ctrl.fusion.params, opts.fusion || {});
  Object.assign(ctrl.arm.params, opts.arm || {});
  Object.assign(ctrl.params, opts.ctrl || {});
  const sim = new SimPhone((s) => ctrl.push(s));
  sim.clock = () => now;
  Object.assign(sim.net, opts.net || {});
  if (opts.armSwing !== undefined) sim.armSwing = opts.armSwing;
  sim.setEnabled(true);
  // perfect calibration (the calibration solver itself is covered by unit tests)
  ctrl.calib.G.copy(sim.G);
  ctrl.calib.setYaw(sim.yawRef);

  const tgt = { pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3(), dir: new Vector3() };
  const q = new Quaternion();
  const results = {};
  const swings = opts.swings || ['horizontal', 'diagonal', 'vertical', 'rising', 'thrust'];
  let phase = null;
  const step = () => {
    now += H * 1000;
    // the game's rAF runs at ~60 Hz; sim delivery is checked once per frame
    if (Math.round(now / (H * 1000)) % 4 === 0) sim.update(now);
    if (ctrl.ready) ctrl.target(now, tgt);
    sc.target.pos.copy(tgt.pos); sc.target.quat.copy(tgt.quat); sc.target.w.copy(tgt.w); sc.target.v.copy(tgt.v);
    sc.step(H, -9.81);
    world.step();
    if (phase) {
      const r = body.rotation();
      q.set(r.x, r.y, r.z, r.w);
      // what the player sees at screen time (now + display latency) vs. where their hand is then
      const truth = sim.poseAt(now + (opts.displayMs ?? 30)).q;
      const e = deg(quatAngle(q, truth));
      phase.max = Math.max(phase.max, e);
      phase.sum += e * e; phase.n++;
      const av = body.angvel(), lv = body.linvel(), c = body.worldCom(), tr = body.translation();
      const tip = new Vector3(0, SWORD.tip, 0).applyQuaternion(q).add(new Vector3(tr.x, tr.y, tr.z));
      const vt = new Vector3(av.x, av.y, av.z).cross(tip.clone().sub(new Vector3(c.x, c.y, c.z))).add(new Vector3(lv.x, lv.y, lv.z));
      phase.tip = Math.max(phase.tip, vt.length());
      // ground-truth tip speed: intended pose + arm model grip
      const tDir = new Vector3(0, 1, 0).applyQuaternion(truth);
      const tTip = ctrl.arm.baseGrip(tDir, new Vector3()).addScaledVector(tDir, SWORD.tip);
      if (phase.prevTip) phase.tipTrue = Math.max(phase.tipTrue, tTip.distanceTo(phase.prevTip) / H);
      phase.prevTip = tTip;
      const gTip = tgt.pos.clone().addScaledVector(new Vector3(0, 1, 0).applyQuaternion(tgt.quat), SWORD.tip);
      if (phase.prevG) phase.tipTarget = Math.max(phase.tipTarget || 0, gTip.distanceTo(phase.prevG) / H);
      phase.prevG = gTip;
      // lag estimate: error between sword and the truth from k ms ago (best k)
      phase.hist.push(truth.clone());
      if (phase.hist.length > 40) phase.hist.shift();
      for (let k = 0; k < phase.hist.length; k += 4) phase.lagErr[k] = (phase.lagErr[k] || 0) + quatAngle(q, phase.hist[phase.hist.length - 1 - k]) ** 2;
      phase.offset = Math.max(phase.offset, ctrl.arm.offset.length());
      if (ctrl.fusion.w.length() > 5) { phase.inv = Math.max(phase.inv || 0, ctrl.involvement); phase.r = Math.max(phase.r || 0, ctrl.leverR); }
      // blade speed across the blade at 0.75 m from the grip (the cutting zone)
      const pz = tip.clone().sub(new Vector3(tr.x, tr.y, tr.z)).multiplyScalar(0.75 / SWORD.tip).add(new Vector3(tr.x, tr.y, tr.z));
      const vz = new Vector3(av.x, av.y, av.z).cross(pz.clone().sub(new Vector3(c.x, c.y, c.z))).add(new Vector3(lv.x, lv.y, lv.z));
      const bdir = new Vector3(0, 1, 0).applyQuaternion(q);
      phase.cutV = Math.max(phase.cutV || 0, vz.addScaledVector(bdir, -vz.dot(bdir)).length());
    }
  };
  for (let i = 0; i < 240; i++) step(); // settle
  for (const name of swings) {
    sim.swing(name);
    phase = { max: 0, sum: 0, n: 0, tip: 0, tipTrue: 0, offset: 0, hist: [], lagErr: [] };
    for (let i = 0; i < 240 * 1.8; i++) step();
    let bestK = 0;
    phase.lagErr.forEach((v, k) => { if (v !== undefined && v < phase.lagErr[bestK]) bestK = k; });
    results[name] = { maxDeg: +phase.max.toFixed(1), rmsDeg: +Math.sqrt(phase.sum / phase.n).toFixed(1), lagMs: +(bestK * H * 1000).toFixed(0),
      tipMs: +phase.tip.toFixed(1), cutZoneMs: +(phase.cutV || 0).toFixed(1), lever: +(phase.r || 0).toFixed(2), involve: +(phase.inv || 0).toFixed(2), thrustCm: +(phase.offset * 100).toFixed(0) };
    phase = null;
    for (let i = 0; i < 120; i++) step();
  }
  return results;
}

function summary(r) {
  const v = Object.values(r);
  return { worstMax: Math.max(...v.map((x) => x.maxDeg)), meanRms: +(v.reduce((a, x) => a + x.rmsDeg, 0) / v.length).toFixed(1) };
}

if (process.argv[2] === 'sweep') {
  const rows = [];
  const swings = ['horizontal', 'vertical', 'diagonal', 'rising'];
  for (const predictMs of [15, 25, 35, 45]) {
    for (const smoothMs of [0, 12, 22]) {
      for (const stopAware of [false, true]) {
        const r = run({ fusion: { predictMs, smoothMs, stopAware }, swings });
        const v = Object.values(r);
        const over = v.reduce((a, x) => a + x.tipMs / x.tipTrue, 0) / v.length;
        rows.push({ predictMs, smoothMs, stopAware, ...summary(r), tipRatio: +over.toFixed(2) });
      }
    }
  }
  console.table(rows);
} else {
  const r = run(process.argv[2] ? JSON.parse(process.argv[2]) : {});
  console.table(r);
  console.log(summary(r));
}
