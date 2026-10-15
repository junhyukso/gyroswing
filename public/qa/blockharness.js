// QA harness for the block drill (dev only). In a `?manual` page:
//   const H = await import('/qa/blockharness.js'); await H.setup(); await H.run(0, 6, H.STATIC)
// Poses are body-frame blade/edge directions; the simulated phone holds them during each windup.
const g = window.game, T = g.THREE;
const b = g.blockDrill;
export const V = (x, y, z) => new T.Vector3(x, y, z).normalize();
export const P = (x, y, z) => new T.Vector3(x, y, z);
export function pose(d, e) {
  const bb = d.clone().normalize();
  const x = e.clone();
  x.addScaledVector(bb, -x.dot(bb)).normalize();
  return new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(x, bb, new T.Vector3().crossVectors(x, bb)));
}
export const KEY_LABEL = {
  overhead: '정수리 내려베기', diagR: '왼쪽 위 사선베기', horizL: '오른쪽 수평베기',
  diagL: '오른쪽 위 사선베기', horizR: '왼쪽 수평베기', thrust: '찌르기',
};
const REST = () => pose(V(0, 0.35, -1), V(0, -1, 0));

/** Idealised block poses (what the guard layer was first designed around). */
export const STATIC = {
  overhead: [pose(V(-1, 0.08, -0.25), V(0, 1, 0))],
  diagR: [pose(V(-0.3, 0.92, -0.25), V(-0.95, 0.3, 0)), P(-0.05, 0.15, 0)],
  diagL: [pose(V(0.15, 0.95, -0.3), V(0.95, 0.3, 0)), P(0, 0.15, 0)],
  horizL: [pose(V(0.1, -1, -0.15), V(1, 0, 0))],
  horizR: [pose(V(-0.1, -1, -0.15), V(-1, 0, 0))],
  thrust: [pose(V(0.5, 0.25, -0.83), V(-1, 0, 0))],
};

/** Real block holds from a recording (tools/blocks.mjs --json): [[attackKey, dir, edge], ...] -> sets of 6. */
export function fromHolds(holds) {
  const sets = [];
  for (const [key, d, e] of holds) {
    let s = sets.find((x) => !x[key]);
    if (!s) sets.push((s = {}));
    s[key] = [pose(V(...d), V(...e))];
  }
  return sets;
}

export async function setup(station = 5) {
  g.advance(17);
  document.getElementById('btnSim').click();
  for (let i = 0; i < 600 && g.flow.active; i++) g.advance(50);
  g.goStation(station);
  g.advance(1500);
}

/** Run n attacks of the fixed order at a level; blocks: {attackKey: [quat, trans?]}. */
export async function run(level, n, blocks = STATIC, onStrike = {}) {
  b.setLevel(level); b.order = 0; b.queue = [];
  g.sim.holdPose(REST(), 0, 0.4); g.advance(300);
  const lines = [], hands = [];
  let last = b.stats[level].attacks, posed = false, swept = false;
  for (let i = 0; i < 3000 && lines.length < n; i++) {
    g.advance(20);
    const key = b.attack && b.attack.key;
    if (b.state === 'windup' && !posed) {
      const p = blocks[key];
      if (p) g.sim.holdPose(p[0], 0, Math.min(0.4, b.windup * 0.7), p[1] || null);
      posed = true;
    }
    const s = onStrike[key];
    if (b.state === 'strike' && !swept && s && b.stateT >= s[2]) { g.sim.holdPose(s[0], 0, s[1], s[3] || null); swept = true; }
    if (b.state === 'strike' && b.stateT < 0.03) hands.push({ key, hand: g.handBody?.().toArray().map((x) => +x.toFixed(2)) });
    if (b.state === 'idle') { posed = false; swept = false; }
    const st = b.stats[level];
    if (st.attacks !== last) { last = st.attacks; lines.push(`${key}: ${b.lastLine}`); g.sim.holdPose(REST(), 0, 0.5); }
  }
  return { lines, stats: { ...b.stats[level] }, hands };
}

const ORDER = ['overhead', 'diagR', 'horizL', 'diagL', 'horizR', 'thrust'];
const IOS = { perm: [2, 0, 1], sign: [1, 1, 1], scale: Math.PI / 180, confident: true };

/**
 * Replay a real recording into the game (sensor samples at their original timing) with the drill's
 * attacks scheduled from the block holds found in it (tools/blocks.mjs --json): each strike starts
 * `lead` s after the matching hold began (the player was already in place a little before the strike).
 *   holds: [{ t, attack }, ...]   returns one line per attack
 */
export async function replay(name, holds, { level = 0, lead = 0.1 } = {}) {
  const rec = await (await fetch('/rec/' + name)).json();
  const S = rec.samples, c = g.ctrl;
  g.sim.setEnabled(false);
  c.fusion.reset();
  c.fusion.mapping = { ...IOS }; c.fusion.accSign = -1;
  if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
  if (rec.meta?.stances) c.arm.fromJSON(rec.meta.stances);
  b.setLevel(level); b.queue = [];
  const sched = holds.map((h) => ({ ...h, start: h.t + lead - b.lv.windup }));
  const v0 = g.now(), r0 = S[0].recv;
  const lines = [];
  let i = 0, k = 0, last = b.stats[level].attacks, cur = null;
  const end = (S.at(-1).recv - r0) / 1000;
  while ((g.now() - v0) / 1000 < end) {
    const tRec = (g.now() - v0) / 1000;
    while (i < S.length && (S[i].recv - r0) / 1000 <= tRec) { c.push({ ...S[i], recv: v0 + (S[i].recv - r0) }); i++; }
    if (b.state === 'idle') {
      if (k < sched.length && tRec >= sched[k].start) { cur = sched[k++]; b.order = ORDER.indexOf(cur.attack); b.stateT = b.lv.pause + 0.001; }
      else b.stateT = 0;
    }
    g.advance(1000 / 60);
    const st = b.stats[level];
    if (st.attacks !== last) { last = st.attacks; lines.push(`${cur.t.toFixed(1)} ${cur.attack}: ${b.lastLine}`); }
  }
  return { lines, stats: { ...b.stats[level] } };
}

/** A beat from a block pose: the blade turns toward its edge by `deg` (a parry snap). */
export function beat(q, deg = 35) {
  const d = new T.Vector3(0, 1, 0).applyQuaternion(q), e = new T.Vector3(1, 0, 0).applyQuaternion(q);
  const a = (deg * Math.PI) / 180;
  return pose(d.clone().multiplyScalar(Math.cos(a)).addScaledVector(e, Math.sin(a)), e.clone().multiplyScalar(Math.cos(a)).addScaledVector(d, -Math.sin(a)));
}

/**
 * Replay a recording that carries drill events (F9 since 2026-10-15): attacks start exactly when they
 * did in the recording (same kind, same level), the phone samples at their original timing.
 */
export async function replayEvents(name) {
  const rec = await (await fetch('/rec/' + name)).json();
  const S = rec.samples, c = g.ctrl, r0 = S[0].recv;
  const sched = rec.events.filter((e) => e.type === 'drill' && e.ev === 'attack').map((e) => ({ t: (e.recv - r0) / 1000, attack: e.key, level: e.level, windup: e.windup }));
  const recorded = rec.events.filter((e) => e.type === 'drill' && e.ev === 'result').map((e) => e.line);
  g.sim.setEnabled(false);
  c.fusion.reset();
  c.fusion.mapping = { ...IOS }; c.fusion.accSign = -1;
  if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
  if (rec.meta?.stances) c.arm.fromJSON(rec.meta.stances);
  if (sched.length) b.setLevel(sched[0].level);
  b.queue = [];
  for (const st of b.stats) Object.assign(st, { attacks: 0, blocked: 0, parried: 0, evaded: 0, hitHead: 0, hitTorso: 0 });
  const v0 = g.now();
  const lines = [];
  let i = 0, k = 0, cur = null, last = 0;
  const end = (S.at(-1).recv - r0) / 1000;
  while ((g.now() - v0) / 1000 < end) {
    const tRec = (g.now() - v0) / 1000;
    while (i < S.length && (S[i].recv - r0) / 1000 <= tRec) { c.push({ ...S[i], recv: v0 + (S[i].recv - r0) }); i++; }
    if (b.state === 'idle') {
      if (k < sched.length && tRec >= sched[k].t) {
        cur = sched[k++];
        if (b.level !== cur.level) b.setLevel(cur.level);
        b.order = ORDER.indexOf(cur.attack); b.stateT = b.lv.pause + 0.001;
      } else b.stateT = 0;
    }
    g.advance(1000 / 60);
    const n = b.stats.reduce((a, st) => a + st.attacks, 0);
    if (n !== last) { last = n; lines.push(`${cur.t.toFixed(1)} L${cur.level + 1} ${cur.attack}: ${b.lastLine}  [recorded: ${recorded[lines.length] ?? '?'}]`); }
  }
  const tot = b.stats.reduce((a, st) => { for (const k2 in st) a[k2] = (a[k2] || 0) + st[k2]; return a; }, {});
  return { lines, stats: tot };
}

/**
 * Replay a ZIG SIM recording (Core Motion attitude + ARKit) into the game the way ZIG mode feeds it,
 * with the drill's attacks at their recorded times. Returns one line per attack (+ the recorded one).
 */
export async function replayZig(name, { arkit = true } = {}) {
  const rec = await (await fetch('/rec/' + name)).json();
  const Zs = rec.events.filter((e) => e.type === 'zig' && e.d?.sensordata?.quaternion).sort((a, b) => a.recv - b.recv);
  const c = g.ctrl, r0 = Zs[0].recv;
  const sched = rec.events.filter((e) => e.type === 'drill' && e.ev === 'attack').map((e) => ({ t: (e.recv - r0) / 1000, attack: e.key, level: e.level }));
  const recorded = rec.events.filter((e) => e.type === 'drill' && e.ev === 'result').map((e) => e.line);
  g.sim.setEnabled(false);
  c.fusion.reset(); c.arkit.reset();
  if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
  if (rec.meta?.stances) c.arm.fromJSON(rec.meta.stances);
  if (sched.length) b.setLevel(sched[0].level);
  b.queue = [];
  for (const st of b.stats) Object.assign(st, { attacks: 0, blocked: 0, parried: 0, evaded: 0, hitHead: 0, hitTorso: 0 });
  const v0 = g.now();
  const lines = [];
  let i = 0, k = 0, cur = null, last = 0;
  const end = (Zs.at(-1).recv - r0) / 1000;
  while ((g.now() - v0) / 1000 < end) {
    const tRec = (g.now() - v0) / 1000;
    while (i < Zs.length && (Zs[i].recv - r0) / 1000 <= tRec) {
      const s = Zs[i].d.sensordata, t = v0 + (Zs[i].recv - r0);
      const att = new T.Quaternion(...s.quaternion).normalize();
      const w = new T.Vector3(...(s.gyro || [0, 0, 0]));
      const a = new T.Vector3(...(s.accel || [0, 0, 0])).multiplyScalar(-9.81);
      c.pushAttitude({ t, recv: t, q: att, w, a, stickX: 0, stickY: 0, buttons: 0 });
      if (arkit && s.arkitposition && s.arkitrotation) c.pushArkit({ t, recv: t, pos: s.arkitposition, rot: s.arkitrotation, att, w: w.length(), fp: s.arkitfeaturepoints?.count ?? 0 });
      i++;
    }
    if (b.state === 'idle') {
      if (k < sched.length && tRec >= sched[k].t) {
        cur = sched[k++];
        if (b.level !== cur.level) b.setLevel(cur.level);
        b.order = ORDER.indexOf(cur.attack); b.stateT = b.lv.pause + 0.001;
      } else b.stateT = 0;
    }
    g.advance(1000 / 60);
    const n = b.stats.reduce((a2, st) => a2 + st.attacks, 0);
    if (n !== last) { last = n; lines.push(`${cur.t.toFixed(1)} ${cur.attack}: ${b.lastLine}  [recorded: ${recorded[lines.length] ?? '?'}]`); }
  }
  const tot = b.stats.reduce((a2, st) => { for (const k2 in st) a2[k2] = (a2[k2] || 0) + st[k2]; return a2; }, {});
  return { lines, stats: tot };
}
