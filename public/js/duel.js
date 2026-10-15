// GyroSword duel — local multiplayer. Two players, each with their own phone (their seat's QR, or a ZIG
// SIM phone claimed by touching it), calibrate and fight with physical swords.
//  - Both on this PC: split screen, one first-person view each.
//  - The second player on another PC: that PC opens /duel?join=<room>. It runs its player's input and
//    calibration itself, sends the sword target here, and draws the fight from this page's snapshots.
// This page (the host) runs the one physics world: blades meet, bind and deflect for real; a hit on the
// other body counts by how hard and how cleanly it lands (edge alignment, thrust along the blade).
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createRenderer, buildWorld, makeComposer, ARENA_R } from './world.js';
import { SWORD } from './sword.js';
import { FX, Trail } from './fx.js';
import { Fighter, layerOf, TEAM, setLayers } from './fighter.js';
import { Seat, emptyTarget, idleTarget } from './seat.js';
import { buildCalGhost, buildCalRing } from './calvisuals.js';
import { RING_POS } from './calibflow.js';

await RAPIER.init();

const $ = (id) => document.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const qs = new URLSearchParams(location.search);
const JOIN = /^[a-z0-9]{4,12}$/.test(qs.get('join') || '') ? qs.get('join') : null;
const HOST = !JOIN;
const SIM = qs.has('sim');        // QA: simulated phones
const MANUAL = qs.has('manual');  // QA: nothing runs on its own; duel.advance(ms) steps a virtual clock
const ROOM = JOIN || Math.random().toString(36).slice(2, 8).padEnd(6, '0');
const SEAT_IDS = [ROOM + 'a', ROOM + 'b'];
const SUFFIX = ['-a', '-b'];
const PHYS_HZ = 240, H = 1 / PHYS_HZ, GRAVITY = -9.81;
const WIN_ROUNDS = 2;            // best of three
// 1.8 m apart: a thrust or a cut with the arm reaches the other body, a guard stays ~15 cm short of it
// (only a NEW contact counts: a point resting on the other body and then pushed wouldn't)
const START = [{ pos: V(0, 0, 0.9), yaw: 0 }, { pos: V(0, 0, -0.9), yaw: Math.PI }];
// damage: a cut with the single-player cutting energy (70 J) does perRef; flat / pommel hits a fraction.
// A thrust is slower (3–6 m/s along the blade) but driven by the arm and body and concentrated on the
// point: its own reference (thrustRef J, always the arm's mass)
const DMG = { energyRef: 70, thrustRef: 20, perRef: 25, max: 35, head: 1.5, min: 3, mWrist: 0.35, mArm: 1.5 };
document.body.classList.add(HOST ? 'host' : 'guest');

// ------------------------------------------------------------------ renderer / scene
const renderer = createRenderer($('c'));
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
const scene = new THREE.Scene();
const cams = [0, 1].map((i) => { const c = new THREE.PerspectiveCamera(70, 1, 0.04, 3000); c.layers.enable(layerOf(i)); return c; });
const world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
world.timestep = H;
world.numSolverIterations = 8;
const env = buildWorld({ renderer, scene, camera: cams[0], RAPIER, world });
env.sun.shadow.mapSize.set(2048, 2048);
const views = [
  { cam: cams[0], post: env, w: 0, h: 0, look: V(0, 1.2, -1) },
  { cam: cams[1], post: makeComposer(renderer, scene, cams[1]), w: 0, h: 0, look: V(0, 1.2, 1) },
];
const fx = new FX(scene);
const trails = [fx.trail, new Trail(scene)];
const F = [0, 1].map((i) => new Fighter({ i, scene, RAPIER, world, physics: HOST }));
for (const f of F) f.reset(START[f.i].pos, START[f.i].yaw, idleTarget(emptyTarget()));

// ------------------------------------------------------------------ UI helpers
let toastTimer = 0;
function toast(msg, ms = 1400) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function flash(i) {
  const el = $('vig' + SUFFIX[i]);
  el.style.opacity = 1;
  setTimeout(() => { el.style.opacity = 0; }, 260);
}
const feedLines = [];
function feed(text, color) {
  feedLines.unshift({ text, color, at: performance.now() });
  feedLines.length = Math.min(feedLines.length, 4);
  $('feed').innerHTML = feedLines.map((l) => `<div style="color:${l.color}">${l.text}</div>`).join('');
  clearTimeout(feed._t);
  feed._t = setTimeout(() => { $('feed').innerHTML = ''; feedLines.length = 0; }, 5000);
}

// calibration visuals per player (on that player's camera layer only)
const calVis = [0, 1].map((i) => {
  const ghost = buildCalGhost(), ring = buildCalRing();
  scene.add(ghost, ring);
  setLayers(ghost, layerOf(i)); setLayers(ring, layerOf(i));
  return {
    target: null, grip: V(), hideSword: false, ghost, ring,
    showTarget(quat, grip, dim = false) {
      this.target = quat ? quat.clone() : null;
      if (grip) this.grip.copy(grip);
      ghost.visible = !!quat;
      ghost.userData.ghostMat.opacity = dim ? 0.18 : 0.5;
    },
    showRing(v) { ring.visible = v; },
    setLive(v) { this.hideSword = !v; },
    setTargetState(s) { ghost.userData.ghostMat.color.setHex(s === 'ok' ? 0x7dff9a : 0xffc94a); },
  };
});

// ------------------------------------------------------------------ seats (players' input on this page)
let virtualNow = performance.now();
const clock = MANUAL ? () => virtualNow : () => performance.now();
const seats = [null, null];
const started = [false, false]; // the seat's calibration was started this session
function makeSeat(i) {
  const s = new Seat({
    id: SEAT_IDS[i], n: i + 1,
    // a second player on this PC keeps their own calibration; on a guest PC its player is "the" player
    store: HOST && i === 1 ? '.p2' : '',
    suffix: SUFFIX[i], fx, toast, view: calVis[i], sim: SIM, clock,
    onButton: (kind) => {
      if (kind === 'double') s.flow.start('full');
      else if (kind === 'hold') s.flow.start('heading');
      else tap(i);
    },
    onCalibrated: () => lobbyPrompt(i),
  });
  started[i] = false;
  return s;
}
if (HOST) seats[0] = makeSeat(0);
seats[1] = makeSeat(1);

// the other side of a room: the guest's player on the host / the host's fight on the guest
const link = { ws: null, on: false, sentAt: 0, seatKey: '' };
const guest = { tgt: idleTarget(emptyTarget()), at: 0, inv: 1, stick: { x: 0, y: 0 }, live: false, cal: false, calibrated: false, via: '' };
function connectLink() {
  const ws = new WebSocket(`ws://${location.host}/ws?role=duel&room=${ROOM}&side=${HOST ? 'host' : 'guest'}`);
  ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onLink(m); };
  ws.onclose = () => { link.ws = null; if (HOST) setGuest(false); else link.on = false; setTimeout(connectLink, 1000); };
  link.ws = ws;
}
const linkSend = (o) => { if (link.ws && link.ws.readyState === 1) link.ws.send(JSON.stringify(o)); };
connectLink();

function setGuest(on) {
  if (!HOST || on === link.on) return;
  link.on = on;
  if (on) {
    // the seat's phone now belongs to the guest page (same seat id): let go of it here
    if (seats[1]) { seats[1].close(); seats[1] = null; }
    toast('2P가 다른 컴퓨터에서 접속했습니다', 2200);
  } else {
    Object.assign(guest, { live: false, cal: false, at: 0 });
    if (!seats[1]) seats[1] = makeSeat(1);
    toast('2P 컴퓨터 연결이 끊겼습니다 — 이 컴퓨터에서 2P를 받습니다', 2600);
  }
  layout();
}

function onLink(m) {
  if (m.type === 'peer') {
    if (HOST) setGuest(m.guests > 0);
    else { link.on = m.host; layout(); }
    return;
  }
  if (HOST) {
    if (m.t === 'tgt') {
      const T = guest.tgt;
      T.pos.fromArray(m.p); T.quat.fromArray(m.q); T.v.fromArray(m.v); T.w.fromArray(m.w);
      T.dir.set(0, 1, 0).applyQuaternion(T.quat);
      guest.at = clock(); guest.inv = m.inv; guest.stick.x = m.sx; guest.stick.y = m.sy;
    } else if (m.t === 'seat') Object.assign(guest, { live: m.live, cal: m.cal, calibrated: m.calibrated, via: m.via });
    else if (m.t === 'tap') tap(1);
  } else {
    if (m.t === 'snap') onSnap(m);
    else if (m.t === 'prompt') seats[1].net.prompt(m.title, m.text, m.opts || {});
    else if (m.t === 'haptic') seats[1].net.haptic(m.n, m.gap);
  }
}

/** What the game knows about player i's input (local seat or the guest's). */
function seatState(i) {
  const s = seats[i];
  if (s) return { live: s.live, cal: s.flow.active, calibrated: s.calibrated, via: s.via, local: true };
  if (HOST && i === 1 && link.on) return { live: guest.live, cal: guest.cal, calibrated: guest.calibrated, via: guest.via ? `다른 PC · ${guest.via}` : '다른 PC', local: false };
  return { live: false, cal: false, calibrated: false, via: '', local: false };
}
function promptSeat(i, title, text, opts = {}) {
  if (seats[i]) { if (!seats[i].flow.active) seats[i].net.prompt(title, text, opts); }
  else if (HOST && i === 1 && link.on && !guest.cal) linkSend({ t: 'prompt', title, text, opts });
}
function hapticSeat(i, n, gap = 45) {
  if (seats[i]) seats[i].net.haptic(n, gap);
  else if (HOST && i === 1 && link.on) linkSend({ t: 'haptic', n, gap });
}

// ------------------------------------------------------------------ game state (host)
const game = { state: 'lobby', t: 0, wins: [0, 0], ready: [false, false], banner: '', winner: -1 };
function lobbyPrompt(i) {
  if (game.state === 'lobby' || game.state === 'matchEnd') {
    promptSeat(i, game.ready[i] ? '준비 완료' : '준비', game.ready[i] ? '상대를 기다리는 중…' : '준비되면 화면을 탭하세요\n두 번 탭 = 다시 보정 · 길게 = 정면 재정렬');
  } else promptSeat(i, '대결 중', '길게 누르기 = 정면 재정렬\n두 번 탭 = 다시 보정');
}
/** A player's tap: ready in the lobby / after a match. */
function tap(i) {
  if (!HOST) { linkSend({ t: 'tap' }); return; }
  if (game.state !== 'lobby' && game.state !== 'matchEnd') return;
  const st = seatState(i);
  if (!st.live || st.cal) return;
  game.ready[i] = !game.ready[i];
  fx.sfx.play('tick');
  toast(`${TEAM[i].name} ${game.ready[i] ? '준비 완료' : '준비 취소'}`);
  lobbyPrompt(i);
  if (game.ready[0] && game.ready[1]) {
    if (game.state === 'matchEnd') game.wins = [0, 0];
    startRound();
  }
}
function startRound() {
  game.state = 'countdown'; game.t = 0; game.winner = -1;
  for (const f of F) { f.hp = 100; f.hitCooldown = 0; f.reset(START[f.i].pos, START[f.i].yaw, targetFor(f.i, clock(), _tb[f.i])); }
  for (const i of [0, 1]) promptSeat(i, '곧 시작', '3', { tick: true });
  fx.sfx.play('tick');
}
function setState(s) { game.state = s; game.t = 0; }
function ko(att) {
  game.wins[att]++;
  game.winner = att;
  setState('ko');
  fx.sfx.play('chime');
  for (const i of [0, 1]) { promptSeat(i, i === att ? '승리!' : '패배', `${game.wins[i]} : ${game.wins[1 - i]}`); hapticSeat(i, i === att ? 2 : 5, 70); }
}
function updateGame(dt) {
  if (!HOST) return;
  game.t += dt;
  const st = [seatState(0), seatState(1)];
  for (const i of [0, 1]) if (game.ready[i] && (!st[i].live || st[i].cal)) { game.ready[i] = false; lobbyPrompt(i); }
  const name = (i) => TEAM[i].name;
  switch (game.state) {
    case 'lobby':
      game.banner = !st[0].live || !st[1].live ? '' : game.ready[0] && game.ready[1] ? '' : '둘 다 준비되면 시작 — 폰 화면 탭';
      break;
    case 'countdown': {
      const k = 3 - Math.floor(game.t);
      game.banner = k > 0 ? String(k) : '시작!';
      if (k !== game._k) { game._k = k; if (k > 0) { fx.sfx.play('tick'); for (const i of [0, 1]) promptSeat(i, String(k), '', { tick: true }); } }
      if (game.t >= 3) { setState('fight'); fx.sfx.play('chime'); for (const i of [0, 1]) promptSeat(i, '대결!', '베고 막으세요\n길게 누르기 = 정면 재정렬'); }
      break;
    }
    case 'fight':
      game.banner = game.t < 0.7 ? '시작!' : '';
      break;
    case 'ko':
      game.banner = `${name(game.winner)} 승!`;
      if (game.t > 2.6) {
        if (game.wins[game.winner] >= WIN_ROUNDS) {
          setState('matchEnd');
          game.ready = [false, false];
          for (const i of [0, 1]) promptSeat(i, i === game.winner ? '최종 승리!' : '최종 패배', '다시 하려면 화면을 탭하세요');
        } else startRound();
      }
      break;
    case 'matchEnd':
      game.banner = `${name(game.winner)} 최종 승리! — 다시 하려면 둘 다 폰 탭`;
      break;
  }
}

// ------------------------------------------------------------------ input -> targets / movement
const _tb = [emptyTarget(), emptyTarget()];
const _q = new THREE.Quaternion(), _w = V();
function targetFor(i, t, out) {
  if (seats[i]) return seats[i].target(t, out);
  if (HOST && i === 1 && link.on && guest.at) {
    // the guest's latest target, carried forward along its own velocities for up to 50 ms
    const dt = Math.min(0.05, Math.max(0, (t - guest.at) / 1000));
    const T = guest.tgt;
    out.pos.copy(T.pos).addScaledVector(T.v, dt);
    _w.copy(T.w).multiplyScalar(dt);
    const a = _w.length();
    out.quat.copy(a > 1e-6 ? _q.setFromAxisAngle(_w.multiplyScalar(1 / a), a).multiply(T.quat) : T.quat);
    out.v.copy(T.v); out.w.copy(T.w); out.dir.set(0, 1, 0).applyQuaternion(out.quat);
    return out;
  }
  return idleTarget(out);
}
function involvement(i) { return seats[i] ? seats[i].ctrl.involvement : HOST && i === 1 ? guest.inv : 1; }

const keys = new Set();
const KEYMOVE = [['KeyW', 'KeyS', 'KeyA', 'KeyD'], ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']];
function moveInput(i) {
  const st = seats[i] ? seats[i].stick : HOST && i === 1 ? guest.stick : { x: 0, y: 0 };
  const k = KEYMOVE[HOST ? i : 0];
  return V(st.x + (keys.has(k[3]) ? 1 : 0) - (keys.has(k[2]) ? 1 : 0), 0, st.y + (keys.has(k[1]) ? 1 : 0) - (keys.has(k[0]) ? 1 : 0));
}
const _np = [V(), V()];
// Stepping into a cut: from 1.8 m a guard stays short of the other body and a cut from the spot falls
// just short (sim: tip 1.3–1.5 m ahead); a hard swing carries the body forward up to LUNGE.max, back slowly
const LUNGE = { max: 0.4, v0: 5, v1: 12, in: 0.06, out: 0.5 }; // tip speed m/s -> 0..max; s
function moveFighters(dt) {
  const canMove = game.state === 'lobby' || game.state === 'fight' || game.state === 'matchEnd';
  for (const f of F) {
    const mv = canMove ? moveInput(f.i) : V();
    if (mv.lengthSq() > 1) mv.normalize();
    _np[f.i].copy(f.base).addScaledVector(mv.applyQuaternion(f.yawQ), 1.4 * dt);
    const want = canMove ? LUNGE.max * Math.max(0, Math.min(1, (f.tipSpeed - LUNGE.v0) / (LUNGE.v1 - LUNGE.v0))) : 0;
    f.lunge += (want - f.lunge) * (1 - Math.exp(-dt / (want > f.lunge ? LUNGE.in : LUNGE.out)));
  }
  // keep apart (bodies don't overlap, lunges included) and inside the arena
  const d = V().subVectors(_np[1], _np[0]); d.y = 0;
  const dist = d.length(), minD = 1.0 + F[0].lunge + F[1].lunge;
  if (dist < minD) { const push = (minD - dist) / 2; d.setLength(1); _np[0].addScaledVector(d, -push); _np[1].addScaledVector(d, push); }
  for (const p of _np) { const r = Math.hypot(p.x, p.z); if (r > ARENA_R - 1) p.multiplyScalar((ARENA_R - 1) / r); }
  for (const f of F) {
    const o = _np[1 - f.i], p = _np[f.i];
    f.base.copy(p);
    const yaw = Math.atan2(-(o.x - p.x), -(o.z - p.z)); // always face the other
    f.place(_vt.set(-Math.sin(yaw), 0, -Math.cos(yaw)).multiplyScalar(f.lunge).add(p), yaw, dt);
    f.hitCooldown = Math.max(0, f.hitCooldown - dt);
  }
}

// ------------------------------------------------------------------ contacts (host)
const eventQueue = new RAPIER.EventQueue(true);
const lastClash = { t: 0 };
const pending = []; // events for the guest's next snapshot
function contactOf(h1, h2) {
  let point = null, normal = null;
  world.contactPair(world.getCollider(h1), world.getCollider(h2), (m, flipped) => {
    if (point) return;
    if (m.numSolverContacts() > 0) { const sp = m.solverContactPoint(0); point = V(sp.x, sp.y, sp.z); }
    const n = m.normal(); normal = V(n.x, n.y, n.z).multiplyScalar(flipped ? -1 : 1);
  });
  if (!point) { const a = world.getCollider(h1).translation(), b = world.getCollider(h2).translation(); point = V((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); }
  return { point, normal: normal || V(0, 1, 0) };
}
function ownerOfSword(h) { for (const f of F) if (f.swordCols.has(h)) return f.i; return -1; }
function zoneOf(h) { for (const f of F) { const z = f.zones.get(h); if (z) return { f: f.i, zone: z }; } return null; }

function onContact(h1, h2, now) {
  const a = ownerOfSword(h1), b = ownerOfSword(h2);
  if (a >= 0 && b >= 0) { clash(h1, h2, now); return; }
  if (a >= 0) { const z = zoneOf(h2); if (z) hit(a, h1, z.f, z.zone, h2); return; }
  if (b >= 0) { const z = zoneOf(h1); if (z) hit(b, h2, z.f, z.zone, h1); }
}

function clash(h1, h2, now) {
  if (now - lastClash.t < 80) return;
  const a = ownerOfSword(h1), b = ownerOfSword(h2);
  const c = contactOf(h1, h2);
  const rel = F[a].pointVel(c.point).sub(F[b].pointVel(c.point));
  const speed = Math.abs(rel.dot(c.normal)) || rel.length() * 0.5;
  if (speed < 1) return;
  lastClash.t = now;
  const e = { k: 'clash', p: c.point.toArray(), s: speed, n: c.normal.toArray() };
  showEvent(e);
  pending.push(e);
  for (const i of [0, 1]) hapticSeat(i, speed > 7 ? 3 : speed > 3.5 ? 2 : 1, 40);
}

function hit(att, swordHandle, def, zone, zoneHandle) {
  if (game.state !== 'fight' || F[att].hitCooldown > 0) return;
  const A = F[att], D = F[def], s = A.snap;
  const part = A.swordCols.get(swordHandle);
  const c = contactOf(swordHandle, zoneHandle);
  // the striking blade's own speed (not relative to the other body): walking onto a still point is no hit
  const v = A.pointVel(c.point);
  const along = v.dot(s.axisY);
  const perp = v.clone().addScaledVector(s.axisY, -along);
  const speed = perp.length();
  const align = speed > 1e-3 ? Math.abs(perp.dot(s.axisX)) / speed : 0;
  const u = c.point.clone().sub(s.grip).dot(s.axisY); // how far along the blade it landed
  let kind, eff, q;
  if (part === 'blade' && u > SWORD.tip - 0.22 && along > 2.5 && along > speed) { kind = 'thrust'; eff = along; q = 1; }
  else if (part === 'blade') { kind = align > 0.55 ? 'cut' : 'flat'; eff = speed; q = align > 0.55 ? 1 : 0.35; }
  else { kind = 'bash'; eff = speed; q = 0.25; }
  const mEff = kind === 'thrust' ? DMG.mArm : DMG.mWrist + (DMG.mArm - DMG.mWrist) * involvement(att);
  const energy = 0.5 * mEff * eff * eff;
  const ref = kind === 'thrust' ? DMG.thrustRef : DMG.energyRef;
  let dmg = Math.min(DMG.max, (energy / ref) * DMG.perRef) * q * (zone === 'head' ? DMG.head : 1);
  const e = { k: 'hit', a: att, d: def, z: zone, kind, dmg: 0, p: c.point.toArray(), s: eff, al: Math.round(along * 10) / 10, u: Math.round(u * 100) / 100, part };
  if (dmg < DMG.min) { e.k = 'touch'; showEvent(e); pending.push(e); return; }
  dmg = Math.round(dmg);
  e.dmg = dmg;
  D.hp = Math.max(0, D.hp - dmg);
  A.hitCooldown = 0.45;
  showEvent(e);
  pending.push(e);
  hapticSeat(def, 4, 60);
  hapticSeat(att, 2, 40);
  fx.hitStop(clock(), dmg > 20 ? 60 : 35);
  if (D.hp <= 0) ko(att);
}

const KIND = { cut: '베기', thrust: '찌르기', flat: '칼등', bash: '자루 치기' };
const ZONE = { head: '머리', torso: '몸통' };
const shakeAmt = [0, 0];
const eventLog = []; // QA: recent fight events
/** Sound, sparks, flashes for a fight event (host directly, guest from snapshots). */
function showEvent(e) {
  eventLog.push({ at: Math.round(performance.now()), ...e }); if (eventLog.length > 60) eventLog.shift();
  const p = V().fromArray(e.p);
  if (e.k === 'clash') {
    fx.sfx.play('metal', Math.min(1.4, e.s / 8));
    fx.burst('spark', p, 6 + Math.round(e.s * 2.5), V().fromArray(e.n), 1.4);
    for (const i of [0, 1]) shakeAmt[i] = Math.min(0.03, shakeAmt[i] + 0.002 + e.s * 0.0006);
  } else if (e.k === 'touch') {
    fx.sfx.play('leather', 0.5);
  } else if (e.k === 'hit') {
    fx.sfx.play('metal', Math.min(1.3, e.dmg / 22));
    fx.sfx.play('hurt', Math.min(1.3, e.dmg / 25));
    fx.burst('spark', p, 10 + e.dmg, null, 1.6);
    shakeAmt[e.d] = Math.min(0.04, shakeAmt[e.d] + 0.012 + e.dmg * 0.0006);
    flash(e.d);
    feed(`${TEAM[e.a].name} → ${TEAM[e.d].name} ${ZONE[e.z]} ${KIND[e.kind]} −${e.dmg}`, TEAM[e.a].css);
  }
}

// ------------------------------------------------------------------ guest: snapshots from the host
const snaps = [];
function onSnap(m) {
  snaps.push({ at: performance.now(), m });
  if (snaps.length > 6) snaps.shift();
  for (const e of m.ev || []) showEvent(e);
  game.state = m.st; game.wins = m.w; game.ready = m.r; game.banner = m.b; game.winner = m.win;
  guestHost.s0 = m.s0;
  for (const i of [0, 1]) F[i].hp = m.f[i].hp;
}
const guestHost = { s0: null };
const _sp = V(), _sq = new THREE.Quaternion(), _sq2 = new THREE.Quaternion();
/** Guest: place fighters and swords between the two snapshots around (now - delay). */
function applySnaps(now, dt) {
  if (!snaps.length) return false;
  const tR = now - 28;
  let a = snaps[0], b = snaps[snaps.length - 1];
  for (let k = 0; k < snaps.length - 1; k++) if (snaps[k].at <= tR && snaps[k + 1].at >= tR) { a = snaps[k]; b = snaps[k + 1]; break; }
  const u = b.at > a.at ? Math.max(0, Math.min(1, (tR - a.at) / (b.at - a.at))) : 1;
  for (const i of [0, 1]) {
    const fa = a.m.f[i], fb = b.m.f[i];
    _sp.set(fa.p[0] + (fb.p[0] - fa.p[0]) * u, 0, fa.p[1] + (fb.p[1] - fa.p[1]) * u);
    let dy = fb.y - fa.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    F[i].place(_sp, fa.y + dy * u, dt);
    F[i].sword.p.fromArray(fa.sp).lerp(_sp.fromArray(fb.sp), u);
    F[i].sword.q.copy(_sq.fromArray(fa.sq)).slerp(_sq2.fromArray(fb.sq), u);
    F[i].tipSpeed = fb.ts;
  }
  return true;
}
for (const f of F) f.sword = { p: V(), q: new THREE.Quaternion() };

// ------------------------------------------------------------------ layout / DOM
function activeViews() {
  if (!HOST) return [1];
  return seats[1] ? [0, 1] : [0];
}
function layout() {
  const v = activeViews();
  document.body.classList.toggle('split', v.length === 2);
  document.body.classList.toggle('single', v.length === 1);
  // AO costs most and scales with pixels: off when two views share the frame
  for (const x of views) if (x.post.gtao) x.post.gtao.enabled = v.length === 1;
}
layout();

fetch('/info').then((r) => r.json()).then((info) => {
  for (const i of [0, 1]) {
    $('qr' + SUFFIX[i]).src = `/qr.svg?seat=${SEAT_IDS[i]}&p=${i + 1}`;
    $('url' + SUFFIX[i]).textContent = `${info.phoneUrl}?seat=${SEAT_IDS[i]}&p=${i + 1}`;
  }
  const ip = info.ips?.[0] || location.hostname;
  $('joinUrl').textContent = `http://${ip}:${info.httpPort}/duel?join=${ROOM}`;
}).catch(() => {});
for (const i of [0, 1]) $('zig' + SUFFIX[i]).addEventListener('click', () => { seats[i]?.claimZig(); });
$('btnSound').addEventListener('click', () => { fx.sfx.unlock(); $('btnSound').classList.add('hidden'); });
addEventListener('pointerdown', () => { if (!fx.sfx.ok) { fx.sfx.unlock(); $('btnSound').classList.add('hidden'); } });

function updateDom() {
  for (const i of [0, 1]) {
    const st = HOST ? seatState(i) : i === 1 ? seatState(1) : (guestHost.s0 || { live: false });
    const local = !!seats[i];
    // the seat's connect panel: only while its phone isn't there yet (and only where its player looks)
    $('lobby' + SUFFIX[i]).classList.toggle('hidden', !local || st.live);
    const zigBtn = $('zig' + SUFFIX[i]), s = seats[i];
    if (s) {
      zigBtn.textContent = s.zigWaiting ? (s.zigFree && performance.now() - s.zigFree.at < 1500 ? `ZIG SIM 감지됨 (${s.zigFree.name}) — 그 폰 화면을 터치하세요` : 'ZIG SIM 폰 화면을 터치하세요… (앱에서 Start)') : 'ZIG SIM으로 연결';
      $('st' + SUFFIX[i]).textContent = st.live ? `연결됨 · ${st.via}` : s.net.phones > 0 ? '폰 연결됨 — 폰에서 "센서 시작"' : '폰 연결 대기';
      $('st' + SUFFIX[i]).className = 'pill ' + (st.live ? 'ok' : s.net.phones > 0 ? '' : 'bad');
    }
    const tag = `${TEAM[i].name}${st.live ? '' : ' · 연결 대기'}${st.cal ? ' · 보정 중' : ''}${(game.state === 'lobby' || game.state === 'matchEnd') && st.live && !st.cal ? (game.ready[i] ? ' · 준비 완료' : ' · 준비되면 폰 탭') : ''}`;
    $('tag' + SUFFIX[i]).textContent = tag;
    $('hp' + SUFFIX[i]).style.width = `${F[i].hp}%`;
    $('hpn' + SUFFIX[i]).textContent = F[i].hp;
  }
  $('wins').textContent = `${game.wins[0]} : ${game.wins[1]}`;
  $('banner').textContent = game.banner;
  $('banner').classList.toggle('big', /^(\d|시작!)$/.test(game.banner));
  $('remote').classList.toggle('hidden', !(HOST && link.on));
  $('remote').textContent = `2P: 다른 컴퓨터에서 접속 중${guest.live ? ` · ${guest.via}` : ' · 폰 연결 대기'}${guest.cal ? ' · 보정 중' : ''}`;
  $('waitHost').classList.toggle('hidden', HOST || link.on);
}

// ------------------------------------------------------------------ keyboard
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  const me = HOST ? 0 : 1;
  switch (e.code) {
    case 'KeyC': seats[me]?.flow.start('full'); break;                 // 1P (guest: its player)
    case 'Space': if (!seats[me]?.flow.active) seats[me]?.flow.start('heading'); e.preventDefault(); break;
    case 'KeyF': if (seats[me]?.flow.active) seats[me].flow.onTap(); else tap(me); break;
    case 'KeyN': if (HOST) seats[1]?.flow.start('full'); break;        // 2P on this PC
    case 'Enter': if (HOST && seats[1] && !seats[1].flow.active) seats[1].flow.start('heading'); break;
    case 'KeyJ': if (HOST) { if (seats[1]?.flow.active) seats[1].flow.onTap(); else tap(1); } break;
  }
  if (e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));

// ------------------------------------------------------------------ main loop
let last = clock(), acc = 0;
const tipW = V(), baseW = V(), _vt = V(), _qt = new THREE.Quaternion(), _qNow = new THREE.Quaternion();
const swDraw = [{ p: V(), q: new THREE.Quaternion() }, { p: V(), q: new THREE.Quaternion() }];
// ?timer: setTimeout loop (a hidden QA tab, where rAF stops); ?pump: message-channel loop at ~60 Hz, which
// background tabs don't throttle either (QA of host + guest as two tabs of one browser)
const schedule = qs.has('timer') ? (f) => setTimeout(f, 16) : qs.has('pump') ? (() => {
  const ch = new MessageChannel();
  let fn = null, at = 0;
  ch.port1.onmessage = () => { if (performance.now() - at >= 16) { at = performance.now(); fn(); } else ch.port2.postMessage(0); };
  return (f) => { fn = f; ch.port2.postMessage(0); };
})() : requestAnimationFrame;
function frame() { schedule(frame); tick(clock(), true); }

function tick(now, render) {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  const prevNow = last;
  last = now;
  for (const s of seats) s?.update(now, dt);
  // a phone that just started streaming: calibrate (quick re-centre when this player calibrated before)
  for (const i of [0, 1]) {
    const s = seats[i];
    if (s && !started[i] && s.live) { started[i] = true; s.flow.start(s.calibrated ? 'heading' : 'full'); }
  }

  if (HOST) {
    updateGame(dt);
    moveFighters(dt);
    for (const f of F) { const off = seatState(f.i).cal; if (f.collide === off) f.setCollide(!off); }
    // physics substeps (inputs sampled at each substep's time)
    acc += dt * fx.timeScale(now);
    let n = Math.floor(acc / H);
    if (n > 16) { n = 16; acc = 0; }
    for (let k = 0; k < n; k++) {
      acc -= H;
      const tSub = prevNow + ((now - prevNow) * (k + 1)) / n;
      for (const f of F) {
        f.setTarget(targetFor(f.i, tSub, _tb[f.i]));
        f.ctl.step(H, GRAVITY);
        f.snapshot();
        f.storePrev();
      }
      world.step(eventQueue);
      eventQueue.drainCollisionEvents((h1, h2, startedEv) => { if (startedEv) onContact(h1, h2, now); });
      for (const f of F) {
        const r = f.swordBody.rotation(), t = f.swordBody.translation();
        const q = _qt.set(r.x, r.y, r.z, r.w);
        baseW.set(0, 0.55, 0).applyQuaternion(q).add(_vt.set(t.x, t.y, t.z));
        tipW.set(0, SWORD.tip, 0).applyQuaternion(q).add(_vt);
        f.tipSpeed = f.pointVel(tipW, _vt).length();
        trails[f.i].push(now / 1000 - (n - 1 - k) * H, baseW, tipW, f.tipSpeed);
      }
    }
    // draw each sword between its last two physics states (a constant one-step delay, even motion)
    const alpha = Math.min(1, Math.max(0, acc / H));
    for (const f of F) {
      const r = f.swordBody.rotation(), t = f.swordBody.translation();
      swDraw[f.i].p.set(t.x, t.y, t.z).lerp(f.swPrev.p, 1 - alpha);
      swDraw[f.i].q.copy(f.swPrev.q).slerp(_qNow.set(r.x, r.y, r.z, r.w), alpha);
    }
    sendSnapshot(now);
  } else {
    if (applySnaps(performance.now(), dt)) for (const f of F) { swDraw[f.i].p.copy(f.sword.p); swDraw[f.i].q.copy(f.sword.q); }
    // the guest's own player: target and seat state to the host
    const s = seats[1];
    if (s && link.on && now - link.sentAt > 8) {
      link.sentAt = now;
      const T = s.target(now, _tb[1]), st = moveInput(1);
      const r4 = (a) => a.map((x) => Math.round(x * 1e4) / 1e4);
      linkSend({ t: 'tgt', p: r4(T.pos.toArray()), q: r4(T.quat.toArray()), v: r4(T.v.toArray()), w: r4(T.w.toArray()), inv: s.ctrl.involvement, sx: st.x, sy: st.z });
      const key = `${s.live}|${s.flow.active}|${s.calibrated}|${s.via}`;
      if (key !== link.seatKey || now - (link.seatAt || 0) > 1000) { link.seatKey = key; link.seatAt = now; linkSend({ t: 'seat', live: s.live, cal: s.flow.active, calibrated: s.calibrated, via: s.via }); }
    }
    for (const f of F) { // trails from the drawn blades
      baseW.set(0, 0.55, 0).applyQuaternion(swDraw[f.i].q).add(swDraw[f.i].p);
      tipW.set(0, SWORD.tip, 0).applyQuaternion(swDraw[f.i].q).add(swDraw[f.i].p);
      trails[f.i].push(now / 1000, baseW, tipW, f.tipSpeed);
    }
  }

  // ---- visuals
  const eyes = F.map((f) => f.eye());
  for (const f of F) f.draw(swDraw[f.i].p, swDraw[f.i].q, eyes[f.i], eyes[1 - f.i], calVis[f.i].hideSword && !!seats[f.i]?.flow.active);
  for (const i of [0, 1]) {
    const cv = calVis[i], f = F[i];
    if (cv.ghost.visible && cv.target) { cv.ghost.position.copy(cv.grip).applyQuaternion(f.yawQ).add(f.pos); cv.ghost.quaternion.copy(f.yawQ).multiply(cv.target); }
    if (cv.ring.visible) { cv.ring.position.copy(RING_POS).applyQuaternion(f.yawQ).add(f.pos); cv.ring.quaternion.copy(cams[i].quaternion); }
  }
  const mine = HOST ? [0, 1] : [1];
  fx.sfx.whoosh(Math.max(...mine.map((i) => F[i].tipSpeed)));
  const viewList = activeViews();
  for (const i of [0, 1]) {
    shakeAmt[i] *= Math.exp(-dt * 14);
    const f = F[i], v = views[i], a = shakeAmt[i];
    v.cam.position.copy(eyes[i]).add(_vt.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a));
    const look = V(0, 1.38, -1.6).applyQuaternion(f.yawQ).add(f.pos);
    const tipLook = V(0, 0.75, 0).applyQuaternion(swDraw[i].q).add(swDraw[i].p);
    if (!seats[i]?.flow.active) look.lerp(tipLook, 0.12);
    v.look.lerp(look, 1 - Math.exp(-dt * 6));
    v.cam.lookAt(v.look);
  }
  const lead = (i) => ({ t: now / 1000, base: V(0, 0.55, 0).applyQuaternion(swDraw[i].q).add(swDraw[i].p), tip: V(0, SWORD.tip, 0).applyQuaternion(swDraw[i].q).add(swDraw[i].p) });
  const camMain = cams[viewList[0]];
  fx.update(dt, now / 1000, camMain.position, lead(0));
  trails[1].update(now / 1000, camMain.position, lead(1));
  env.update(now / 1000);
  updateDom();
  if (render) renderViews(dt, viewList);
}

let snapAt = 0;
function sendSnapshot(now) {
  if (!link.on || now - snapAt < 15) return;
  snapAt = now;
  const r4 = (a) => a.map((x) => Math.round(x * 1e4) / 1e4);
  const s0 = seatState(0);
  linkSend({
    t: 'snap', st: game.state, w: game.wins, r: game.ready, b: game.banner, win: game.winner,
    s0: { live: s0.live, cal: s0.cal },
    f: F.map((f) => {
      const t = f.swordBody.translation(), q = f.swordBody.rotation();
      return { p: r4([f.pos.x, f.pos.z]), y: Math.round(f.yaw * 1e4) / 1e4, sp: r4([t.x, t.y, t.z]), sq: r4([q.x, q.y, q.z, q.w]), hp: f.hp, ts: Math.round(f.tipSpeed * 10) / 10 };
    }),
    ev: pending.splice(0),
  });
}

let viewW = 0, viewH = 0;
function renderViews(dt, list) {
  const W = innerWidth, Hh = innerHeight;
  if (W < 2 || Hh < 2) return;
  if (W !== viewW || Hh !== viewH) { viewW = W; viewH = Hh; renderer.setSize(W, Hh, false); }
  const vw = Math.floor(W / list.length);
  list.forEach((i, k) => {
    const v = views[i];
    if (v.w !== vw || v.h !== Hh) {
      v.w = vw; v.h = Hh;
      v.post.composer.setSize(vw, Hh);
      v.cam.aspect = vw / Hh; v.cam.updateProjectionMatrix();
    }
    renderer.setViewport(k * vw, 0, vw, Hh);
    renderer.setScissor(k * vw, 0, vw, Hh);
    renderer.setScissorTest(list.length > 1);
    v.post.composer.render(dt);
  });
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, Hh);
}

if (!MANUAL) schedule(frame);

// debugging / automated QA handle
window.duel = {
  THREE, F, seats, game, world, fx, cams, guest, link, tap, startRound, seatState, eventLog, DMG, room: ROOM,
  sim: (i) => seats[i]?.sim,
  /** ?manual: advance the virtual clock by ms in 60 Hz frames (renders the last one). */
  advance(ms, step = 1000 / 60) { for (let t = 0; t < ms; t += step) { virtualNow += step; tick(virtualNow, t + step >= ms); } },
};
