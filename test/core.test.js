import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Quaternion, Vector3 } from 'three';
import { eulerToQuat, quatToEuler, quatAngle, Q_EW, quatFromBasis, yawQuat, expRot } from '../public/js/orient.js';
import { Fusion } from '../public/js/fusion.js';
import { Calibration } from '../public/js/calib.js';
import { ArmModel, STANCES } from '../public/js/armmodel.js';
import { synthSample, bodyRate, randomQuat } from '../public/js/synth.js';

const deg = (r) => (r * 180) / Math.PI;

test('W3C euler <-> quaternion round trip, including the upright singularity', () => {
  let worst = 0;
  for (let i = 0; i < 5000; i++) {
    const q = randomQuat();
    const e = quatToEuler(q);
    assert.ok(e.beta >= -180 && e.beta < 180.0001, `beta range ${e.beta}`);
    assert.ok(e.gamma >= -90.0001 && e.gamma < 90.0001, `gamma range ${e.gamma}`);
    worst = Math.max(worst, quatAngle(q, eulerToQuat(e.alpha, e.beta, e.gamma)));
  }
  // phone upright (beta ~ 90)
  for (let i = 0; i < 500; i++) {
    const q = eulerToQuat(Math.random() * 360, 89.9 + Math.random() * 0.2, Math.random() * 170 - 85);
    const e = quatToEuler(q);
    worst = Math.max(worst, quatAngle(q, eulerToQuat(e.alpha, e.beta, e.gamma)));
  }
  assert.ok(deg(worst) < 0.01, `worst ${deg(worst)} deg`);
});

// sword pose helpers (world frame)
const S_FWD = quatFromBasis(new Vector3(0, -1, 0), new Vector3(0, 0, -1), new Vector3(1, 0, 0));
function swordUp(twist) {
  const q = quatFromBasis(new Vector3(0, 0, -1), new Vector3(0, 1, 0), new Vector3(1, 0, 0));
  return new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), twist).multiply(q);
}
// device attitude that realizes sword pose S given true grip G and true heading Y
function devFor(S, G, Y) {
  return Q_EW.clone().invert().multiply(Y.clone().invert()).multiply(S).multiply(G.clone().invert());
}

test('calibration recovers grip and heading from the two poses', () => {
  for (let i = 0; i < 300; i++) {
    const Gt = randomQuat();
    const Yt = yawQuat(Math.random() * Math.PI * 2);
    const qUp = devFor(swordUp(Math.random() * 6), Gt, Yt);
    const qFwd = devFor(S_FWD, Gt, Yt);
    const sol = Calibration.solve(qUp, qFwd);
    assert.ok(sol.ok);
    assert.equal(sol.warnings.length, 0);
    const c = new Calibration();
    c.apply(sol);
    assert.ok(deg(quatAngle(c.G, Gt)) < 0.01, 'grip');
    // any later pose maps back to the true sword pose
    const S = randomQuat();
    const back = c.swordQuat(devFor(S, Gt, Yt));
    assert.ok(deg(quatAngle(back, S)) < 0.01, 'pose');
  }
});

test('calibration tolerates sloppy poses (10° off)', () => {
  const Gt = randomQuat();
  const Yt = yawQuat(1.2);
  const tiltUp = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.17);
  const tiltF = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.17);
  const qUp = devFor(tiltUp.multiply(swordUp(0.3)), Gt, Yt);
  const qFwd = devFor(tiltF.multiply(S_FWD), Gt, Yt);
  const c = new Calibration();
  c.apply(Calibration.solve(qUp, qFwd));
  const S = randomQuat();
  assert.ok(deg(quatAngle(c.swordQuat(devFor(S, Gt, Yt)), S)) < 22);
});

// the six on-screen target poses used by the guided calibration (body frame)
function targetPoses() {
  const pose = (d, e) => {
    const b = new Vector3(...d).normalize();
    const x = new Vector3(...e); x.addScaledVector(b, -x.dot(b)).normalize();
    return quatFromBasis(x, b, new Vector3().crossVectors(x, b));
  };
  return [
    pose([0, 0.03, -1], [0, -1, 0]), pose([0, 1, 0], [0, 0, -1]), pose([0.7, 0.05, -0.7], [0, -1, 0]),
    pose([-0.7, 0.05, -0.7], [0, -1, 0]), pose([0, 0.7, -0.7], [0, -1, 0]), pose([0, -0.3, -0.95], [0, -1, 0]),
  ];
}
function wobble(q, maxDeg) {
  const ax = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  return new Quaternion().setFromAxisAngle(ax, (Math.random() * maxDeg * Math.PI) / 180).multiply(q);
}

test('multi-pose least squares beats the two-pose solve when poses are copied loosely', () => {
  let two = 0, multi = 0;
  const N = 60;
  for (let i = 0; i < N; i++) {
    const Gt = randomQuat();
    const Yt = yawQuat(Math.random() * Math.PI * 2);
    const T = targetPoses();
    // the player copies each pose with up to 8° error
    const qs = T.map((S) => devFor(wobble(S, 8), Gt, Yt));
    const s2 = Calibration.solve(qs[1], qs[0]);
    const sm = Calibration.solveMulti(T.map((S, k) => ({ q: qs[k], S })), s2);
    const err = (sol) => {
      const c = new Calibration(); c.apply(sol);
      // mean error over random later poses
      let e = 0;
      for (let k = 0; k < 20; k++) { const S = randomQuat(); e += deg(quatAngle(c.swordQuat(devFor(S, Gt, Yt)), S)); }
      return e / 20;
    };
    two += err(s2); multi += err(sm);
  }
  two /= N; multi /= N;
  assert.ok(multi < two, `multi ${multi.toFixed(2)} vs two ${two.toFixed(2)}`);
  assert.ok(multi < 6, `multi ${multi.toFixed(2)}°`);
});

test('multi-pose solve drops a pose the player did not copy', () => {
  const Gt = randomQuat();
  const Yt = yawQuat(0.7);
  const T = targetPoses();
  const qs = T.map((S) => devFor(wobble(S, 3), Gt, Yt));
  qs[3] = devFor(wobble(T[3], 3).premultiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1.2)), Gt, Yt); // 69° off
  const s2 = Calibration.solve(qs[1], qs[0]);
  const sm = Calibration.solveMulti(T.map((S, k) => ({ q: qs[k], S })), s2);
  assert.deepEqual(sm.dropped, [3]);
  assert.ok(sm.rms < 5, `rms ${sm.rms}`);
});

test('recenter fixes heading only', () => {
  const Gt = randomQuat();
  const c = new Calibration();
  c.G.copy(Gt);
  const Yt = yawQuat(2.5);
  assert.ok(c.recenter(devFor(S_FWD, Gt, Yt)));
  const S = randomQuat();
  assert.ok(deg(quatAngle(c.swordQuat(devFor(S, Gt, Yt)), S)) < 0.01);
});

/** Drive the fusion with a synthetic swinging motion. */
function runMotion(fusion, opts = {}) {
  const dt = 1 / 60;
  let q = randomQuat();
  let worst = 0, sum = 0, n = 0;
  for (let i = 0; i < 1200; i++) {
    const t = i * dt;
    // smooth but vigorous: up to ~15 rad/s on all axes
    const w = new Vector3(Math.sin(t * 2.1) * 9, Math.sin(t * 3.3 + 1) * 12, Math.cos(t * 1.7) * 7);
    const q1 = q.clone().multiply(expRot(w.x, w.y, w.z, dt));
    const wb = bodyRate(q, q1, dt);
    q = q1;
    let s = synthSample(t * 1000, q, wb, new Vector3(), opts);
    if (opts.glitchAt && opts.glitchAt.includes(i)) { s.alpha += 90; s.gamma = -s.gamma; }
    s.recv = t * 1000 + 8 + Math.random() * 6;
    fusion.push(s);
    if (i > 200) {
      const err = deg(quatAngle(fusion.q, q));
      worst = Math.max(worst, err); sum += err; n++;
    }
  }
  return { worst, mean: sum / n };
}

test('fusion tracks vigorous motion', () => {
  const f = new Fusion();
  const r = runMotion(f, { gyroNoise: 0.02, oriNoiseDeg: 0.3 });
  assert.ok(r.mean < 1.5, `mean ${r.mean}`);
  assert.ok(r.worst < 5, `worst ${r.worst}`);
});

test('fusion rejects isolated euler glitches', () => {
  const f = new Fusion();
  const r = runMotion(f, { glitchAt: [400, 401, 700, 950] });
  assert.ok(r.worst < 6, `worst ${r.worst}`);
});

test('fusion auto-detects a wrong gyro axis/unit mapping', () => {
  const f = new Fusion();
  // pretend the platform reports rad/s with alpha/gamma swapped and beta negated
  const D2R = Math.PI / 180;
  const rawMap = (rr) => ({ a: rr.g * D2R, b: -rr.b * D2R, g: rr.a * D2R });
  runMotion(f, { rawMap });
  // after detection the predicted pose should match the true pose closely
  const q = new Quaternion();
  f.poseAt(f.tLast + f.off - f.params.predictMs, q);
  assert.ok(f.mapping.confident, JSON.stringify(f.mapping));
  assert.equal(f.mapping.scale, 1);
});

test('prediction extrapolates along the gyro', () => {
  const f = new Fusion();
  const w = new Vector3(0, 0, 6); // 6 rad/s about device z
  let q = new Quaternion();
  for (let i = 0; i < 120; i++) {
    const s = synthSample(i * 16.667, q, w, new Vector3());
    s.recv = i * 16.667 + 5;
    f.push(s);
    q = q.clone().multiply(expRot(0, 0, 6, 1 / 60));
  }
  // q is now the true attitude 1 frame after the last sample
  f.params.predictMs = 0;
  const out = new Quaternion();
  f.poseAt(f.tLast + f.off + 16.667, out);
  assert.ok(deg(quatAngle(out, q)) < 1.0, `pred err ${deg(quatAngle(out, q))}`);
});

test('fusion recovers when the phone page reloads (its clock restarts)', () => {
  const f = new Fusion();
  const q = randomQuat();
  for (let i = 0; i < 60; i++) { const s = synthSample(600000 + i * 16.667, q, new Vector3(), new Vector3()); s.recv = 5000 + i * 16.667; f.push(s); }
  const q2 = randomQuat();
  for (let i = 0; i < 30; i++) { const s = synthSample(100 + i * 16.667, q2, new Vector3(), new Vector3()); s.recv = 7000 + i * 16.667; f.push(s); }
  assert.ok(deg(quatAngle(f.q, q2)) < 1, 'follows the new session');
});

test('iOS platform hint matches the real iPhone gyro axis order', () => {
  const f = new Fusion();
  f.setPlatformHint('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15');
  // iPhone reports alpha/beta/gamma = rates about device x/y/z
  const iosMap = (rr) => ({ a: rr.b, b: rr.g, g: rr.a });
  const r = runMotion(f, { rawMap: iosMap, gyroNoise: 0.02 });
  assert.equal(f.stats.glitches, 0);
  assert.ok(r.worst < 5, `worst ${r.worst}`);
  assert.equal(f.accSign, -1);
});

test('gravity sign auto-detect', () => {
  const f = new Fusion();
  const q = randomQuat();
  for (let i = 0; i < 60; i++) {
    const s = synthSample(i * 16.667, q, new Vector3(), new Vector3(0, 0, 0), { gravitySign: -1 });
    s.recv = i * 16.667 + 5;
    f.push(s);
  }
  assert.equal(f.accSign, -1);
});

test('arm model reproduces stance grips and stays bounded elsewhere', () => {
  const a = new ArmModel();
  for (const s of STANCES) {
    const g = a.baseGrip(s.dir);
    assert.ok(g.distanceTo(s.grip) < 0.04, `${s.id} off by ${g.distanceTo(s.grip).toFixed(3)}`);
  }
  // calibrated near-duplicates must not blow up
  a.setStanceDir('back', a.stance('high').dir.clone().add(new Vector3(0, 0.02, 0)));
  for (let i = 0; i < 2000; i++) {
    const d = new Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    const g = a.grip(d);
    assert.ok(g.distanceTo(new Vector3(0, 1.36, -0.04)) <= 0.7401, 'reach');
    assert.ok(a.baseGrip(d).length() < 3, 'bounded');
  }
});

test('guard layer: overhead block lifts the hands, side block shifts them, normal stances untouched', () => {
  const a = new ArmModel();
  const V3 = (x, y, z) => new Vector3(x, y, z).normalize();
  // crown block: blade pointing left, edge up
  const crown = a.grip(V3(-1, 0.05, -0.1), new Vector3(), V3(0, 1, 0));
  assert.ok(crown.y > 1.6, `crown hand height ${crown.y.toFixed(2)}`);
  assert.ok(crown.x > 0.05, 'hand on the right when the blade points left');
  // middle guard (edge down) and a horizontal cut follow-through (edge leading left): no lift
  const mid = a.grip(V3(0, 0.35, -1), new Vector3(), V3(0, -1, 0.35));
  assert.ok(mid.y < 1.3, `middle guard ${mid.y.toFixed(2)}`);
  const follow = a.grip(V3(-1, 0.05, -0.3), new Vector3(), V3(-0.3, 0, 1));
  assert.ok(follow.y < 1.3, `follow-through ${follow.y.toFixed(2)}`);
  // side blocks: upright blade, edge facing a side
  const left = a.grip(V3(0, 1, -0.1), new Vector3(), V3(-1, 0, 0));
  const right = a.grip(V3(0, 1, -0.1), new Vector3(), V3(1, 0, 0));
  assert.ok(left.x < -0.12 && right.x > 0.18, `side ${left.x.toFixed(2)} / ${right.x.toFixed(2)}`);
});

test('accelerometer path: a real-sized thrust and a side step come through, rest noise does not drift', () => {
  const dt = 1 / 60;
  const smooth = (x) => x * x * x * (x * (x * 6 - 15) + 10);
  // 30 cm min-jerk move over 0.3 s along `axis`, sampled as acceleration
  const move = (a, axis, dist) => {
    const pos = (t) => dist * smooth(Math.min(1, Math.max(0, t / 0.3)));
    let peak = 0;
    for (let i = 0; i < 90; i++) {
      const t = i * dt;
      const acc = (pos(t + dt) - 2 * pos(t) + pos(t - dt)) / (dt * dt);
      a.integrate(axis.clone().multiplyScalar(acc), 0.2, dt);
      peak = Math.max(peak, a.offset.dot(axis));
    }
    return peak;
  };
  const a1 = new ArmModel();
  const thrust = move(a1, new Vector3(0, 0, -1), 0.3);
  assert.ok(thrust > 0.22, `thrust ${thrust.toFixed(3)} m of 0.30`);
  const a2 = new ArmModel();
  const side = move(a2, new Vector3(1, 0, 0), 0.2);
  assert.ok(side > 0.14, `side ${side.toFixed(3)} m of 0.20`);
  // 5 s of rest with accelerometer noise like a real iPhone (~0.7 m/s² p50)
  const a3 = new ArmModel();
  for (let i = 0; i < 300; i++) {
    const n = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.6);
    a3.integrate(n, 0.15, dt);
  }
  assert.ok(a3.offset.length() < 0.03, `rest drift ${a3.offset.length().toFixed(3)} m`);
});

test('thrust and hold: the hand stays out while still, then returns', () => {
  const a = new ArmModel();
  const dt = 1 / 60;
  let maxZ = 0, atOneSec = 0;
  for (let i = 0; i < 300; i++) {
    const t = i * dt;
    const az = t < 0.1 ? -25 : t < 0.2 ? 25 : 0; // forward = -z
    a.integrate(new Vector3(0, 0, az), 0.3, dt);
    maxZ = Math.min(maxZ, a.offset.z);
    if (Math.abs(t - 1.0) < dt / 2) atOneSec = a.offset.z;
  }
  assert.ok(maxZ < -0.12, `thrust reach ${maxZ}`);
  assert.ok(atOneSec < maxZ * 0.85, `held at 1 s: ${atOneSec} vs ${maxZ}`);
  assert.ok(Math.abs(a.offset.z) < 0.05, `returns ${a.offset.z}`);
});
