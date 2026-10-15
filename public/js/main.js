// GyroSword — first-person physics sword training driven by a phone's gyro.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createRenderer, buildWorld, GROUPS, groups, ARENA_R } from './world.js';
import { buildSwordMesh, swordColliders, SWORD } from './sword.js';
import { SwordController } from './swordctl.js';
import { Controller } from './controller.js';
import { Net } from './net.js';
import { SimPhone, poseFromDir } from './sim.js';
import { Targets } from './targets.js';
import { FX } from './fx.js';
import { Arms } from './arms.js';
import { CalibFlow, RING_POS } from './calibflow.js';
import { Hud, buildGui } from './hud.js';
import { Drills } from './drills.js';
import { BlockDrill } from './blockdrill.js';
import { Perf } from './perf.js';
import { Quality } from './quality.js';
import { ZigDriver } from './zigdrive.js';
import { buildCalGhost, buildCalRing } from './calvisuals.js';

await RAPIER.init();

const $ = (id) => document.getElementById(id);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const PHYS_HZ = 240;
const H = 1 / PHYS_HZ;
const GRAVITY = -9.81;

// ------------------------------------------------------------------ renderer / scene
// render quality: ?q=auto|high|medium|low forces it; otherwise the saved choice (default auto, see quality.js)
const GFX_STORE = 'gyrosword.gfx.v1';
const quality = new URLSearchParams(location.search).get('q') || (() => { try { return JSON.parse(localStorage.getItem(GFX_STORE) || '{}').mode; } catch { return null; } })() || 'auto';
const renderer = createRenderer($('c'));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.04, 3000);
const world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
world.timestep = H;
world.numSolverIterations = 8;
const env = buildWorld({ renderer, scene, camera, RAPIER, world, quality });
const fx = new FX(scene);
const targets = new Targets({ scene, RAPIER, world, fx });
const arms = new Arms(scene);

// ------------------------------------------------------------------ input pipeline
const ctrl = new Controller();
const net = new Net();
const sim = new SimPhone((s) => ctrl.push(s));
net.onSample = (s) => { if (!sim.enabled) ctrl.push(s); };
const drills = new Drills({ scene, targets, toast, sfx: fx.sfx, haptic: (n) => net.haptic(n) });
const blockDrill = new BlockDrill({ scene, RAPIER, world, targets, fx, toast, haptic: (n) => net.haptic(n) });
// F9 recordings also get the drill's attacks and results (same clock as the sensor samples' recv)
blockDrill.onEvent = (e) => { if (net.recording) net.recording.events.push({ type: 'drill', ...e, recv: performance.now() }); };
// QA pages must never drive a real phone that may be in someone's hand
if (/[?&](manual|mute)/.test(location.search)) net.muted = true;

// ------------------------------------------------------------------ player
const player = {
  pos: V(0, 0, 0), yaw: 0, yawQ: new THREE.Quaternion(), vel: V(), yawRate: 0, _prevPos: V(), _prevYaw: 0,
  move: null, // station transition
  ghostUntil: 0, // sword passes through things while the player is relocated
  hitCooldown: 0,
};
const playerBody = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 1.0, 0));
// hit zones: torso (0.7–1.54 m) and head (centre 1.64 m); the body origin sits at feet + 1 m
const playerZones = new Map();
for (const [zone, desc] of [
  ['torso', RAPIER.ColliderDesc.capsule(0.22, 0.2).setTranslation(0, 0.12, 0)],
  ['head', RAPIER.ColliderDesc.ball(0.12).setTranslation(0, 0.64, 0.03)],
]) {
  const c = world.createCollider(desc.setCollisionGroups(groups(GROUPS.PLAYER, GROUPS.TARGET | GROUPS.DEBRIS | GROUPS.ENEMY))
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
    .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.DEFAULT | RAPIER.ActiveCollisionTypes.KINEMATIC_FIXED), playerBody);
  playerZones.set(c.handle, zone);
  targets.material.set(c.handle, 'player');
}

// ------------------------------------------------------------------ sword
const swordBody = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0.04, 1.1, -0.42)
  .setCcdEnabled(true).setCanSleep(false));
const swordCols = {};
{
  const descs = swordColliders(RAPIER);
  const filter = GROUPS.STATIC | GROUPS.TARGET | GROUPS.DEBRIS | GROUPS.ENEMY;
  for (const [k, d] of Object.entries(descs)) {
    d.setCollisionGroups(groups(GROUPS.SWORD, filter)).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    swordCols[k] = world.createCollider(d, swordBody);
  }
}
const swordHandles = new Map(Object.entries(swordCols).map(([k, c]) => [c.handle, k]));
const swordCtl = new SwordController(RAPIER, world, swordBody);
const swordMesh = buildSwordMesh();
scene.add(swordMesh);
const ghost = buildSwordMesh({ ghost: true });
ghost.visible = false;
scene.add(ghost);

// ------------------------------------------------------------------ UI helpers
let toastTimer = 0;
function toast(msg, ms = 1400) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
const hud = new Hud();
const perf = new Perf(renderer);
const PROF_URL = /[?&]prof/.test(location.search);
const PERF_LABELS = { input: '입력', ctrl: '컨트롤러', servo: '칼서보', targets: '표적', block: '막기상대', physics: '물리', events: '충돌', trail: '궤적', sync: '동기화', fx: '효과', render: '렌더제출' };

// calibration visuals: gold target sword (with hand spots) and an aiming ring at the screen centre
const calGhost = buildCalGhost();
scene.add(calGhost);
const calRing = buildCalRing();
scene.add(calRing);
const calView = {
  target: null, grip: V(), liveOnly: false,
  showTarget(quat, grip, dim = false) {
    this.target = quat ? quat.clone() : null;
    if (grip) this.grip.copy(grip);
    calGhost.visible = !!quat;
    calGhost.userData.ghostMat.opacity = dim ? 0.18 : 0.5;
  },
  showRing(v) { calRing.visible = v; },
  setLive(v) { swordMesh.visible = v; arms.calibHide = !v; },
  setTargetState(s) { calGhost.userData.ghostMat.color.setHex(s === 'ok' ? 0x7dff9a : 0xffc94a); },
  // full calibration happens facing the open arena, then the player walks back
  saved: null,
  begin(mode) {
    if (mode !== 'full') return;
    if (!this.saved) this.saved = { pos: player.pos.clone(), yaw: player.yaw };
    player.move = { from: player.pos.clone(), fromYaw: player.yaw, to: V(0, 0, 5.2), toYaw: 0, t: 0 };
  },
  end(mode) {
    if (mode !== 'full' || !this.saved) return;
    player.move = { from: player.pos.clone(), fromYaw: player.yaw, to: this.saved.pos, toYaw: this.saved.yaw, t: 0 };
    this.saved = null;
  },
};

const flow = new CalibFlow({
  ctrl, net, fx, sim, toast, view: calView,
  onFinish: (mode) => { sessionCalibrated = true; toast(mode === 'full' ? '보정 완료 — 휘둘러 보세요!' : '정면 재정렬 완료'); },
});
let sessionCalibrated = false;

const gui = buildGui({
  fusion: { label: '입력 · 센서 융합', target: ctrl.fusion.params, fields: {
    predictMs: [0, 80, 1, '예측 (ms)'], maxPredictMs: [20, 120, 1, '최대 예측 (ms)'], blend: [0.02, 1, 0.01, '자세 보정 강도'],
    glitchDeg: [5, 60, 1, '튐 판정 (°)'], smoothMs: [0, 50, 1, '예측 보정 완화 (ms)'], stopAware: [0, 0, 0, '멈춤 인지 예측'],
    predictGateLo: [0, 2, 0.05, '예측 시작 회전속도'], predictGateHi: [0.1, 4, 0.05, '예측 최대 회전속도'],
    staleHold: [0, 0, 0, '끊김 중 예측 유지'], staleExtraMs: [0, 150, 5, '끊김 중 추가 예측 (감속, ms)'],
    autoMap: [0, 0, 0, '자이로 축 자동 감지'] } },
  steady: { label: '떨림 억제 · 팔 개입', target: ctrl.params, fields: {
    smoothMinHz: [0.5, 60, 0.1, '정지 시 부드러움 (Hz, 낮을수록 강함)'], smoothBeta: [0, 40, 0.5, '움직일 때 풀림 속도'],
    blockAlways: [0, 0, 0, '막기 자세 항상 켜기 (공격 없을 때도)'],
    involve: [0, 0, 0, '손목/팔 스윙 구분'], vWrist: [0.3, 3, 0.05, '이 손 속도까지 손목 스윙 (m/s)'], vArm: [1, 5, 0.05, '이 손 속도부터 팔 스윙 (m/s)'] } },
  arm: { label: '팔 모델 · 찌르기/이동', target: ctrl.arm.params, fields: {
    fGain: [1, 2, 0.05, '찌르기 과장 (1=실제)'], holdTime: [0, 4, 0.1, '찌르고 유지 시간 (s)'], tauX: [0.1, 3, 0.05, '유지 후 복귀 시간 (s)'],
    fW0: [1, 10, 0.5, '이 회전속도부터 팔 모델 신뢰'], fW1: [2, 15, 0.5, '이 회전속도에서 완전히 신뢰'], fTauV: [0.3, 6, 0.1, '측정 속도 누설 (s)'],
    fDeadzone: [0, 2, 0.05, '가속 데드존'], fMaxOffset: [0, 0.8, 0.01, '최대 손 이동 (m)'], sigma: [0.25, 1.2, 0.01, '자세 혼합 폭'],
    reachMax: [0.5, 0.9, 0.01, '팔 길이 (m)'] } },
  sword: { label: '칼 물리', target: swordCtl.params, fields: {
    kLin: [5, 80, 1, '위치 추종'], kAng: [5, 80, 1, '회전 추종'], maxForce: [100, 2000, 10, '최대 힘 (N)'],
    maxTorque: [10, 400, 1, '최대 토크 (N·m) · 무게감'], maxCorrW: [2, 30, 0.5, '따라잡기 회전 한도'], ffLin: [0, 1.2, 0.05, '속도 선행'], ffAng: [0, 1.2, 0.05, '각속도 선행'] } },
  cut: { label: '베기 판정', target: targets.params, fields: {
    cutEnergy: [5, 150, 1, '베기 에너지 (J)'], minAlign: [0.3, 0.99, 0.01, '칼날 정렬 (cos)'],
    mWrist: [0.1, 1.5, 0.05, '손목 스윙 유효질량 (kg)'], mArm: [0.5, 4, 0.05, '팔 스윙 유효질량 (kg)'], minCutSpeed: [1, 15, 0.1, '최소 속도 (m/s)'] } },
  fx: { label: '연출', target: fx.params, fields: { hitStop: [0, 0, 0, '히트스톱'], shake: [0, 0, 0, '화면 흔들림'] } },
  sim: { label: '시뮬레이터 네트워크', target: sim.net, fields: {
    base: [0, 60, 1, '기본 지연 (ms)'], jitter: [0, 40, 1, '지터 (ms)'], spikeProb: [0, 0.05, 0.001, '끊김 확률'] } },
}, (sec) => { if (sec === 'arm') ctrl.arm.invalidate(); }, {
  version: 2,
  migrations: { 2: { fusion: ['smoothMs', 'staleHold', 'staleExtraMs'] } }, // Wi-Fi jitter defaults (2026-10-15)
});

// ------------------------------------------------------------------ connect overlay
fetch('/info').then((r) => r.json()).then((info) => {
  $('qr').src = '/qr.svg';
  $('phoneUrl').textContent = info.phoneUrl;
}).catch(() => {});
function refreshConnect() {
  const c = $('cPhone'), d = $('cData');
  c.textContent = net.phones > 0 ? `폰 연결됨 · ${net.transport}` : '폰 연결 대기';
  c.className = 'pill ' + (net.phones > 0 ? 'ok' : 'bad');
  const rx = inputLive();
  if (rx) ctrl.fusion.updateStats();
  d.textContent = rx ? `센서 수신 중 ${ctrl.fusion.stats.rateHz.toFixed(0)} Hz` : net.phones > 0 ? '센서 데이터 없음 — 폰에서 "센서 시작"을 눌렀는지, 다른 게임 탭이 열려 있지 않은지 확인' : '센서 데이터 없음';
  d.className = 'pill ' + (rx ? 'ok' : '');
}
net.onPhones = refreshConnect;
let started = false;
function enterGame() {
  if (started) return;
  started = true;
  $('connect').classList.add('hidden');
  if (!flow.active) flow.start(ctrl.calib.gripCalibrated ? 'heading' : 'full');
}
$('btnStart').addEventListener('click', () => {
  fx.sfx.unlock();
  $('btnStart').textContent = inputLive() ? '시작!' : '소리 켜짐 ✓ — 폰 연결 대기 중';
  if (inputLive()) enterGame();
});
$('btnSim').addEventListener('click', () => {
  fx.sfx.unlock();
  sim.setEnabled(true);
  ctrl.fusion.reset();
  net.muted = true;
  toast('시뮬레이터: 화면 클릭 → 마우스로 칼 조작 · 휠 = 칼날 회전 · T/Y/U/I/O = 자동 베기', 3500);
  enterGame();
});

net.onEvent = (m) => {
  if (m.type === 'btn' && m.name === 'tap') {
    if (flow.active) flow.onTap();
    else if (blockDrill.active) blockDrill.next();
    else if (drills.active) drills.next();
  } else if (m.type === 'btn' && m.name === 'hold' && m.down) {
    if (flow.active) flow.onHold();
    else if (started) flow.start('heading');
  } else if (m.type === 'hello') {
    ctrl.fusion.setPlatformHint(m.ua);
  } else if (m.type === 'started') {
    toast('폰 센서 시작됨');
    if (fx.sfx.ok) enterGame();
  } else if (m.type === 'cam' || m.type === 'camimg' || m.type === 'caminfo') {
    camProbe(m);
  } else if (m.type === 'zig') {
    zigIn(m);
  }
};

// ZIG SIM Pro (iOS app with ARKit): relayed by the server from UDP. For now: show what arrives (the
// exact message format is checked from real packets) — messages are also kept in F9 recordings.
// When ZIG SIM streams and the Safari controller doesn't, ZIG SIM drives the game (zigdrive.js).
const zigState = { n: 0, rate: 0, t0: 0, last: null, keys: '' };
const zig = new ZigDriver({ ctrl, onEvent: (m) => net.onEvent(m) });
const zigLive = () => zig.live;
const inputLive = () => net.receiving || zigLive();
function zigDrive(sd) {
  if (MANUAL || sim.enabled || net.receiving || !sd.quaternion) return false;
  zig.drive(sd, performance.now() - pausedAccum); // samples on the game clock
  return true;
}
const zigBox = (() => {
  const el = document.createElement('div');
  el.id = 'zigBox';
  el.className = 'mono hidden';
  document.body.appendChild(el);
  return el;
})();
const fmtV = (v) => {
  if (v == null) return '-';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' ? x.toFixed(3) : x)).join(', ');
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}${typeof x === 'number' ? x.toFixed(3) : JSON.stringify(x)}`).join(' ');
  return String(v);
};
function zigIn(m) {
  const now = performance.now();
  zigState.n++;
  if (now - zigState.t0 > 1000) { zigState.rate = (zigState.n * 1000) / (now - zigState.t0 || 1); zigState.n = 0; zigState.t0 = now; }
  zigState.last = m.d;
  const sd = m.d?.sensordata || {};
  zigState.keys = Object.keys(sd).join(', ');
  const ar = sd.arkit || sd.ARKit || null;
  const driving = zigDrive(sd);
  if (now - (zigState.shownAt || 0) < 100) return; // the box at ~10 Hz
  zigState.shownAt = now;
  const k = ctrl.arkit;
  zigBox.classList.remove('hidden');
  zigBox.textContent = [
    `ZIG SIM ${zigState.rate.toFixed(0)}Hz  ${m.d?.device?.name || ''}${driving ? '  · 이걸로 조작 중' : net.receiving ? '  · 사파리 컨트롤러 사용 중' : ''}`,
    `센서: ${zigState.keys || '(없음)'}`,
    ar ? `ARKit 위치 ${fmtV(ar.position)}` : 'ARKit: 없음 (ZIG SIM에서 ARKit을 켜 주세요)',
    driving && ar ? (k.anchor ? `ARKit 신뢰 ${k.trust.toFixed(2)}${k.inGuard ? ' (기본 자세)' : ''} · 손 보정 ${(ctrl._arkOff.length() * 100).toFixed(0)} cm${ctrl.assistsOff ? ' · 막기 보정 꺼짐' : ''}` :'ARKit 기준 잡는 중: 칼을 앞으로 겨누고 잠깐 멈추세요') : '',
    driving && zig.touching ? '터치 중' : '',
  ].filter(Boolean).join('\n');
  clearTimeout(zigState.hide);
  zigState.hide = setTimeout(() => zigBox.classList.add('hidden'), 3000);
}

// camera probe from the phone (feasibility of camera tracking): show what the lens sees + its stats.
// The messages are also in F9 recordings (net records every phone message) -> tools/camprobe.mjs
const camBox = (() => {
  const el = document.createElement('div');
  el.id = 'camProbe';
  el.innerHTML = '<img alt="폰 카메라"><div class="mono"></div>';
  el.classList.add('hidden');
  document.body.appendChild(el);
  return el;
})();
function camProbe(m) {
  if (m.off) { camBox.classList.add('hidden'); return; }
  camBox.classList.remove('hidden');
  if (m.type === 'camimg') camBox.querySelector('img').src = m.img;
  else if (m.type === 'cam') camBox.querySelector('div').textContent = `${m.facing === 'user' ? '앞' : '뒷'}카메라  선명도 ${m.sharp}  특징 ${m.cells}/300  밝기 ${m.bright}  회전 ${m.w} rad/s${net.recording ? '  ● 녹화 중' : ''}`;
}

// ------------------------------------------------------------------ keyboard / mouse
const keys = new Set();
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  switch (e.code) {
    case 'KeyH': hud.toggle(); break;
    case 'KeyG': gui._hidden ? gui.show() : gui.hide(); break;
    case 'KeyC': if (started) flow.start('full'); break;
    case 'Enter': case 'NumpadEnter': if (flow.active) flow.onTap(); break;
    case 'Space': if (started && !flow.active) flow.start('heading'); e.preventDefault(); break;
    case 'KeyR': targets.resetAll(); toast('표적 리셋'); break;
    case 'KeyV': ghost.visible = !ghost.visible; break;
    case 'KeyK': arms.visible = !arms.visible; break;
    case 'KeyM': sim.setEnabled(!sim.enabled); ctrl.fusion.reset(); net.muted = sim.enabled; toast(sim.enabled ? '시뮬레이터 켜짐' : '시뮬레이터 꺼짐'); if (sim.enabled) enterGame(); break;
    case 'F9': toggleRecording(); e.preventDefault(); break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6': goStation(Number(e.code.slice(5)) - 1); break;
    case 'KeyN': if (blockDrill.active) blockDrill.next(); else drills.next(); break;
    case 'KeyB': if (blockDrill.active) blockDrill.prev(); else drills.prev(); break;
    case 'KeyT': sim.swing('diagonal'); break;
    case 'KeyY': sim.swing('horizontal'); break;
    case 'KeyU': sim.swing('vertical'); break;
    case 'KeyI': sim.swing('thrust'); break;
    case 'KeyO': sim.swing('rising'); break;
    case 'KeyP': sim.swing('horizontal', 50); break; // deliberately bad edge alignment
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
$('c').addEventListener('click', () => { if (sim.enabled && document.pointerLockElement !== $('c')) $('c').requestPointerLock(); });
addEventListener('mousemove', (e) => { if (sim.enabled && document.pointerLockElement === $('c')) sim.mouse(e.movementX, e.movementY); });
addEventListener('wheel', (e) => { if (sim.enabled) sim.wheel(e.deltaY); }, { passive: true });

async function toggleRecording() {
  if (!net.recording) {
    net.startRecording({ calib: ctrl.calib.toJSON(), stances: ctrl.arm.toJSON(), params: { fusion: ctrl.fusion.params, arm: ctrl.arm.params } });
    toast('● 녹화 시작 (F9로 정지)');
  } else {
    const name = await net.stopRecording({ mapping: ctrl.fusion.mapping, accSign: ctrl.fusion.accSign });
    toast(name ? `저장됨: ${name}` : '저장 실패', 2500);
  }
}

function goStation(i) {
  const st = targets.stations[i];
  if (!st) return;
  player.move = { from: player.pos.clone(), fromYaw: player.yaw, to: st.pos.clone(), toYaw: st.yaw, t: 0 };
  if (i === 2) targets.resetQuintain();
  toast(st.name);
}

let swordCollide = true;
function setSwordCollisions(on) {
  if (on === swordCollide) return;
  swordCollide = on;
  const filter = on ? GROUPS.STATIC | GROUPS.TARGET | GROUPS.DEBRIS | GROUPS.ENEMY : GROUPS.STATIC;
  for (const c of Object.values(swordCols)) c.setCollisionGroups(groups(GROUPS.SWORD, filter));
}

// ------------------------------------------------------------------ per-step helpers
const tgtBody = { pos: V(), quat: new THREE.Quaternion(), w: V(), v: V(), dir: V() };
const idleQuat = poseFromDir(V(0, 0.35, -1), V(0, -1, 0));
const snap = { bladeHandle: swordCols.blade.handle, grip: V(), axisX: V(), axisY: V(), axisZ: V(), com: V(), linvel: V(), angvel: V() };
const eventQueue = new RAPIER.EventQueue(true);
const lastImpact = new Map();
let simTime = 0;

const _bw = V(), _bd = V(), _qSnap = new THREE.Quaternion(), _pv = V(), _pl = V(); // per-substep temporaries
function bodyTargetToWorld() {
  const T = swordCtl.target;
  T.pos.copy(tgtBody.pos).applyQuaternion(player.yawQ).add(player.pos);
  T.quat.copy(player.yawQ).multiply(tgtBody.quat);
  T.w.copy(tgtBody.w).applyQuaternion(player.yawQ);
  T.v.copy(tgtBody.v).applyQuaternion(player.yawQ);
  // the body carries the sword: add the player's own motion (walking, turning, station moves)
  T.v.add(player.vel).add(_bw.set(0, player.yawRate, 0).cross(_bd.subVectors(T.pos, player.pos)));
  T.w.y += player.yawRate;
}

function computeTarget(t) {
  if (ctrl.ready) ctrl.target(t, tgtBody);
  else {
    tgtBody.quat.copy(idleQuat);
    tgtBody.dir.set(0, 1, 0).applyQuaternion(idleQuat);
    ctrl.arm.grip(tgtBody.dir, tgtBody.pos);
    tgtBody.w.set(0, 0, 0); tgtBody.v.set(0, 0, 0);
  }
  bodyTargetToWorld();
}

function snapshotSword() {
  const t = swordBody.translation(), r = swordBody.rotation(), c = swordBody.worldCom(), lv = swordBody.linvel(), av = swordBody.angvel();
  const q = _qSnap.set(r.x, r.y, r.z, r.w);
  snap.grip.set(t.x, t.y, t.z);
  snap.axisX.set(1, 0, 0).applyQuaternion(q);
  snap.axisY.set(0, 1, 0).applyQuaternion(q);
  snap.axisZ.set(0, 0, 1).applyQuaternion(q);
  snap.com.set(c.x, c.y, c.z);
  snap.linvel.set(lv.x, lv.y, lv.z);
  snap.angvel.set(av.x, av.y, av.z);
  snap.involvement = ctrl.ready ? ctrl.involvement : 1;
  return snap;
}

function pointVel(body, p, out) {
  const lv = body.linvel(), av = body.angvel(), c = body.worldCom();
  return out.set(av.x, av.y, av.z).cross(_pv.set(p.x - c.x, p.y - c.y, p.z - c.z)).add(_pl.set(lv.x, lv.y, lv.z));
}

function onSwordContact(swordHandle, otherHandle, now) {
  const mat = targets.material.get(otherHandle) || 'ground';
  if (mat === 'player') return;
  const key = otherHandle;
  if (now - (lastImpact.get(key) || 0) < 90) return;
  const piece = targets.pieces.get(otherHandle);
  if (piece && piece.passUntil > targets.time) return; // being cut, not a bump
  const c1 = world.getCollider(swordHandle), c2 = world.getCollider(otherHandle);
  let point = null, normal = null;
  world.contactPair(c1, c2, (m, flipped) => {
    if (point) return;
    if (m.numSolverContacts() > 0) {
      const sp = m.solverContactPoint(0);
      point = V(sp.x, sp.y, sp.z);
    } else if (m.numContacts() > 0) {
      const lp = m.localContactPoint1(0);
      const ct = c1.translation(), cr = c1.rotation();
      point = V(lp.x, lp.y, lp.z).applyQuaternion(new THREE.Quaternion(cr.x, cr.y, cr.z, cr.w)).add(V(ct.x, ct.y, ct.z));
    }
    const n = m.normal();
    normal = V(n.x, n.y, n.z).multiplyScalar(flipped ? -1 : 1);
  });
  if (!point) return;
  // relative normal speed using the pre-step sword velocity
  const vs = V().crossVectors(snap.angvel, point.clone().sub(snap.com)).add(snap.linvel);
  const ob = c2.parent();
  const vo = ob ? pointVel(ob, point, V()) : V();
  const rel = vs.sub(vo);
  const speed = Math.abs(rel.dot(normal));
  if (speed < 0.8) return;
  lastImpact.set(key, now);
  const edgeness = Math.abs(normal.dot(snap.axisX));
  const mEff = targets.params.mWrist + (targets.params.mArm - targets.params.mWrist) * (snap.involvement ?? 1);
  const k = Math.min(1.4, (speed / 8) * Math.sqrt(mEff / 1.0));
  const dir = normal.clone().negate();
  switch (mat) {
    case 'wood':
      fx.sfx.play('wood', k);
      fx.burst('wood', point, 4 + Math.round(speed * 1.2), dir, 1.2);
      if (swordHandle === swordCols.blade.handle && edgeness > 0.6 && speed > 3.5 && ob === targets.pell?.body) targets.addMark(point, snap.axisY);
      break;
    case 'metal': fx.sfx.play('metal', k); fx.burst('spark', point, 8 + Math.round(speed * 2), dir, 1.5); break;
    case 'straw': {
      fx.sfx.play('straw', k);
      fx.burst('straw', point, 6, dir, 0.8);
      const st = targets.stats;
      if (swordHandle === swordCols.blade.handle && speed > 2.5) {
        if (piece?.tag === 'drill') drills.onMiss();
        if (st.lastAlign < targets.params.minAlign) toast(`칼날이 틀어짐 — 정렬 ${(st.lastAlign * 100).toFixed(0)}%`);
        else if ((st.lastEnergy ?? 0) < targets.params.cutEnergy) {
          toast(st.lastInvolvement < 0.35
            ? `힘이 안 실렸어요 — 손목만 썼어요 (${st.lastEnergy.toFixed(0)} J)`
            : `힘 부족 — ${st.lastEnergy.toFixed(0)} / ${targets.params.cutEnergy} J`);
        }
      }
      break;
    }
    case 'leather': fx.sfx.play('leather', k); fx.burst('dust', point, 5, dir, 0.6); break;
    case 'disk':
      fx.sfx.play('straw', k * 1.2);
      fx.burst('straw', point, 8, dir, 0.8);
      drills.onDiskHit(point, rel.clone(), snap.axisY);
      break;
    default: fx.sfx.play('ground', k * 0.8); fx.burst('dust', point, 6, V(0, 1, 0), 0.5);
  }
  if (speed > 6 && mat !== 'straw') { fx.hitStop(now, mat === 'metal' ? 55 : 45); fx.shake(0.004 + speed * 0.0007); }
  net.haptic(speed > 9 ? 3 : speed > 5 ? 2 : 1, 40);
}

function hurt(zone, strength = 1) {
  player.hitCooldown = 0.8;
  fx.sfx.play('hurt', Math.min(1.3, strength));
  fx.shake(0.02);
  net.haptic(4, 60);
  $('vignette').style.opacity = 1;
  setTimeout(() => { $('vignette').style.opacity = 0; }, 260);
}

function onPlayerHit(zoneHandle, otherHandle, now) {
  const zone = playerZones.get(zoneHandle);
  // the practice knight's blade
  if (blockDrill.swordHandles.has(otherHandle)) {
    if (blockDrill.swordHandles.get(otherHandle) !== 'blade') return;
    if (blockDrill.onBodyHit(zone, now)) { hurt(zone, 1.1); toast(zone === 'head' ? '머리를 맞았다!' : '몸통을 맞았다!', 1000); }
    return;
  }
  if (player.hitCooldown > 0) return;
  const b = world.getCollider(otherHandle)?.parent();
  if (!b) return;
  const lv = b.linvel();
  const sp = Math.hypot(lv.x, lv.y, lv.z);
  if (sp < 1.2) return;
  hurt(zone, sp / 4);
  toast('맞았다! 막거나 피하세요', 1200);
}

const swPrev = { p: V(), q: new THREE.Quaternion() }; // player sword before the last physics step
const _qTrail = new THREE.Quaternion(), _vTrail = V();
const trailLead = { t: 0, base: V(), tip: V() };
const _qNow = new THREE.Quaternion();
const bladeContacts = new Map(); // attacker blade colliders touching the player's sword: key -> [mine, theirs]

/** Contact point and normal (pointing from collider `from` toward `to`). */
function contactOf(from, to) {
  let point = null, normal = null;
  world.contactPair(world.getCollider(from), world.getCollider(to), (m, flipped) => {
    if (point || m.numSolverContacts() === 0) return;
    const sp = m.solverContactPoint(0); point = V(sp.x, sp.y, sp.z);
    const n = m.normal(); normal = V(n.x, n.y, n.z).multiplyScalar(flipped ? -1 : 1);
  });
  if (!point) { const t = world.getCollider(to).translation(); point = V(t.x, t.y, t.z); }
  return { point, normal };
}

// ------------------------------------------------------------------ main loop
let last = performance.now();
let acc = 0;
let fps = 0;
const tipW = V(), baseW = V();
const camLook = V(0, 1.2, -1);

// ?timer drives the loop with setTimeout (automated QA in a hidden/background tab, where rAF stops)
const TIMER_LOOP = new URLSearchParams(location.search).has('timer');
const schedule = TIMER_LOOP ? (f) => setTimeout(() => f(performance.now()), 16) : requestAnimationFrame;

// debug pause: freezes simulation time (the simulator's clock included), rendering continues
let paused = false, pausedAccum = 0, pausedAt = 0;
// ?manual: nothing runs on its own; game.advance(ms) steps a virtual clock (deterministic QA)
const MANUAL = new URLSearchParams(location.search).has('manual');
let virtualNow = performance.now();
sim.clock = MANUAL ? () => virtualNow : () => performance.now() - pausedAccum;

function frame(nowRaw) {
  schedule(frame);
  if (paused) { env.composer.render(0); return; }
  tick(nowRaw - pausedAccum, true);
}

function tick(now, render) {
  perf.on = hud.visible || PROF_URL;
  const pFrame = perf.now();
  let pt = pFrame;
  let dt = Math.min(0.1, (now - last) / 1000);
  const prevNow = last;
  last = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  sim.update(now);
  flow.update(dt);
  setSwordCollisions(!flow.active && !player.move && now > player.ghostUntil);
  if (!started) refreshConnect();
  if (!started && inputLive() && fx.sfx.ok) enterGame();

  // ---- player movement (keyboard + phone stick)
  if (player.move) {
    const m = player.move;
    m.t = Math.min(1, m.t + dt / 0.7);
    const s = m.t * m.t * (3 - 2 * m.t);
    player.pos.lerpVectors(m.from, m.to, s);
    player.yaw = m.fromYaw + (m.toYaw - m.fromYaw) * s;
    if (m.t >= 1) { player.move = null; player.ghostUntil = now + 350; }
  } else {
    const mv = V((keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0), 0, (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0));
    const st = sim.enabled ? sim.stick : ctrl.stick;
    mv.x += st.x; mv.z += st.y;
    if (mv.lengthSq() > 0.01) {
      if (mv.length() > 1) mv.normalize();
      player.pos.addScaledVector(mv.applyAxisAngle(V(0, 1, 0), player.yaw), 1.6 * dt);
      const r = Math.hypot(player.pos.x, player.pos.z);
      if (r > ARENA_R - 0.8) player.pos.multiplyScalar((ARENA_R - 0.8) / r);
    }
    player.yaw += ((keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0)) * 1.6 * dt;
  }
  player.yawQ.setFromAxisAngle(V(0, 1, 0), player.yaw);
  drills.update(dt, player.pos);
  if (dt > 0) {
    player.vel.subVectors(player.pos, player._prevPos).multiplyScalar(1 / dt);
    player.yawRate = (player.yaw - player._prevYaw) / dt;
  }
  player._prevPos.copy(player.pos);
  player._prevYaw = player.yaw;
  playerBody.setNextKinematicTranslation({ x: player.pos.x, y: player.pos.y + 1.0, z: player.pos.z });
  player.hitCooldown = Math.max(0, player.hitCooldown - dt);
  perf.add('input', pt);

  // ---- physics substeps (input sampled at each substep's real time)
  acc += dt * fx.timeScale(now);
  let n = Math.floor(acc / H);
  if (n > 16) { n = 16; acc = 0; }
  for (let k = 0; k < n; k++) {
    acc -= H;
    const tSub = prevNow + ((now - prevNow) * (k + 1)) / n;
    pt = perf.now();
    ctrl.blockHint = blockDrill.hint();
    computeTarget(tSub);
    perf.add('ctrl', pt); pt = perf.now();
    swordCtl.params.rescueTime = blockDrill.active ? 2.0 : 0.5; // binds with the attacker are legitimate
    if (swordCtl.step(H, GRAVITY)) toast('칼 위치 복구');
    perf.add('servo', pt); pt = perf.now();
    targets.setSwordSnapshot(snapshotSword());
    targets.preStep();
    perf.add('targets', pt); pt = perf.now();
    blockDrill.step(H, player.pos, swordCtl.target);
    perf.add('block', pt); pt = perf.now();
    { // pose before this step: the sword is drawn between the last two physics states (see render sync)
      const r0 = swordBody.rotation(), t0 = swordBody.translation();
      swPrev.p.set(t0.x, t0.y, t0.z); swPrev.q.set(r0.x, r0.y, r0.z, r0.w);
    }
    world.step(eventQueue, targets.hooks);
    simTime += H;
    perf.add('physics', pt); pt = perf.now();
    eventQueue.drainCollisionEvents((h1, h2, startedEv) => {
      const e1 = blockDrill.swordHandles.has(h1), e2 = blockDrill.swordHandles.has(h2);
      if ((e1 && swordHandles.has(h2)) || (e2 && swordHandles.has(h1))) {
        const mine = e1 ? h2 : h1, theirs = e1 ? h1 : h2;
        const key = `${mine}:${theirs}`;
        if (!startedEv) { bladeContacts.delete(key); return; }
        bladeContacts.set(key, [mine, theirs]);
        const c = contactOf(mine, theirs);
        blockDrill.onClash(c.point, snap, now, c.normal);
        return;
      }
      if (!startedEv) return;
      if (swordHandles.has(h1)) onSwordContact(h1, h2, now);
      else if (swordHandles.has(h2)) onSwordContact(h2, h1, now);
      else if (playerZones.has(h1)) onPlayerHit(h1, h2, now);
      else if (playerZones.has(h2)) onPlayerHit(h2, h1, now);
    });
    // blades already crossed when the strike starts (a bind from the wind-up) fire 'started' only once,
    // before it counted — check the standing contact until the attack is judged
    if (bladeContacts.size && blockDrill.wantsClash()) {
      const [mine, theirs] = bladeContacts.values().next().value;
      const c = contactOf(mine, theirs);
      if (c.normal) blockDrill.onClash(c.point, snap, now, c.normal);
    }
    perf.add('events', pt); pt = perf.now();
    for (const c of targets.postStep(H)) {
      fx.sfx.play('cut', Math.min(1.3, c.speed / 10));
      fx.burst('straw', c.point, 22, c.vdir, 1.4);
      fx.hitStop(now, 18, 0.25);
      net.haptic(1);
      if (c.tag === 'drill') drills.onCut(c);
      else toast(`베기! 정렬 ${(c.align * 100).toFixed(0)}% · ${c.speed.toFixed(1)} m/s · ${c.energy.toFixed(0)} J`, 1100);
    }
    // trail samples at physics rate
    const r = swordBody.rotation(), t = swordBody.translation();
    const q = _qTrail.set(r.x, r.y, r.z, r.w);
    baseW.set(0, 0.55, 0).applyQuaternion(q).add(_vTrail.set(t.x, t.y, t.z));
    tipW.set(0, SWORD.tip, 0).applyQuaternion(q).add(_vTrail);
    const tv = pointVel(swordBody, tipW, _vTrail).length();
    fx.trail.push(now / 1000 - (n - 1 - k) * H, baseW, tipW, tv);
    perf.add('trail', pt);
  }
  pt = perf.now();

  // ---- render sync
  // Physics runs at a fixed 240 Hz; a display at 144/165 Hz (or 60 Hz with float drift) gets 1 or 2
  // (3 or 5) steps per frame, so drawing the newest state makes fast blades judder. Draw the state
  // `acc` past the previous step instead: a constant one-step (4 ms) delay, evenly spaced motion.
  const alpha = Math.min(1, Math.max(0, acc / H));
  const r = swordBody.rotation(), t = swordBody.translation();
  swordMesh.position.set(t.x, t.y, t.z).lerp(swPrev.p, 1 - alpha);
  swordMesh.quaternion.copy(swPrev.q).slerp(_qNow.set(r.x, r.y, r.z, r.w), alpha); // (slerpQuaternions would alias)
  blockDrill.update(dt, alpha);
  ghost.position.copy(swordCtl.target.pos);
  ghost.quaternion.copy(swordCtl.target.quat);
  if (calGhost.visible && calView.target) {
    calGhost.position.copy(calView.grip).applyQuaternion(player.yawQ).add(player.pos);
    calGhost.quaternion.copy(player.yawQ).multiply(calView.target);
  }
  if (calRing.visible) {
    calRing.position.copy(RING_POS).applyQuaternion(player.yawQ).add(player.pos);
    calRing.quaternion.copy(camera.quaternion);
  }
  targets.update();
  const eyeLocal = V(0, 1.62, -0.07);
  arms.update(player.pos, player.yawQ, swordMesh.position, swordMesh.quaternion, eyeLocal.clone().applyQuaternion(player.yawQ).add(player.pos));
  const tipSpeed = pointVel(swordBody, V(0, SWORD.tip, 0).applyQuaternion(swordMesh.quaternion).add(swordMesh.position), V()).length();
  fx.sfx.whoosh(tipSpeed);
  perf.add('sync', pt); pt = perf.now();
  // the trail ends at the blade as drawn (between physics steps), not at the newest physics state
  trailLead.t = now / 1000 - (1 - alpha) * H;
  trailLead.base.set(0, 0.55, 0).applyQuaternion(swordMesh.quaternion).add(swordMesh.position);
  trailLead.tip.set(0, SWORD.tip, 0).applyQuaternion(swordMesh.quaternion).add(swordMesh.position);
  fx.update(dt, now / 1000, camera.position, trailLead);
  env.update(now / 1000);
  perf.add('fx', pt);

  // ---- camera: eye on the body, slight head follow toward the blade
  const eye = eyeLocal.clone().applyQuaternion(player.yawQ).add(player.pos).add(fx.shakeOff);
  camera.position.copy(eye);
  const look = V(0, 1.38, -1.6).applyQuaternion(player.yawQ).add(player.pos);
  const tipLook = V(0, 0.75, 0).applyQuaternion(swordMesh.quaternion).add(swordMesh.position);
  if (!flow.active) look.lerp(tipLook, 0.12); // steady view while calibrating
  camLook.lerp(look, 1 - Math.exp(-dt * 6));
  camera.lookAt(camLook);

  hud.update(dt, () => hudText(tipSpeed));
  if (render) {
    fitView();
    pt = perf.now();
    perf.gpuBegin();
    env.composer.render(dt);
    perf.gpuEnd();
    perf.add('render', pt);
  }
  perf.endFrame(perf.on ? performance.now() - pFrame : 0, dt);
  if (render) qual.frame(dt, perf.gpuMs);
}

function hudText(tipSpeed) {
  const f = ctrl.fusion, s = f.stats;
  f.updateStats();
  const m = f.mapping;
  const T = swordCtl;
  const st = targets.stats;
  return [
    `FPS ${fps.toFixed(0)}   입력 ${sim.enabled ? '시뮬레이터' : net.receiving ? '폰' : zigLive() ? 'ZIG SIM' : '없음'}   폰 ${net.phones} (${net.transport})   RTT ${net.rtt.toFixed(0)}ms`,
    `센서 ${s.rateHz.toFixed(0)}Hz  지연(중앙/95%) +${s.lagMs.toFixed(0)}/+${s.lag95Ms.toFixed(0)}ms  손실 ${net.lost}`,
    `융합 오차 ${s.errDeg.toFixed(2)}°  튐 ${s.glitches}  자이로축 [${m.perm}] [${m.sign}] ${m.scale === 1 ? 'rad' : 'deg'} ${m.confident ? '확인됨' : '미확인'}${m.err != null ? ` (${m.err.toFixed(3)})` : ''}  중력부호 ${f.accSign}`,
    `보정: 그립 ${ctrl.calib.gripCalibrated ? 'O' : '기본값'}  방향 ${ctrl.calib.headingCalibrated ? 'O' : 'X'}  자세 ${ctrl.arm.stances.filter((x) => x.calibrated).length}/${ctrl.arm.stances.length}`,
    `칼끝 ${tipSpeed.toFixed(1)} m/s  추종오차 ${(T.err.pos * 100).toFixed(1)}cm ${T.err.angDeg.toFixed(1)}°  힘 포화 ${(T.saturation * 100).toFixed(0)}%`,
    `손 이동 ${(ctrl.arm.offset.length() * 100).toFixed(0)}cm   스윙 손속도 ${ctrl.handPeak.toFixed(1)}m/s → 팔 개입 ${(ctrl.involvement * 100).toFixed(0)}%   정지 ${ctrl.stillTime.toFixed(1)}s`,
    `베기 ${st.cuts}회  마지막 정렬 ${(st.lastAlign * 100).toFixed(0)}%  속도 ${st.lastSpeed.toFixed(1)}m/s  에너지 ${(st.lastEnergy ?? 0).toFixed(0)}J (팔 ${((st.lastInvolvement ?? 1) * 100).toFixed(0)}%)`,
    net.recording ? `● 녹화 중 ${net.recording.samples.length}` : '',
    qual.text(perf.gpuMs),
    perf.text(PERF_LABELS),
  ].filter(Boolean).join('\n');
}

// a minimized/hidden window reports 0×0; never size render targets to zero (black screen until the
// next resize) — instead re-check every frame and resize once there is a real size again
let viewW = 0, viewH = 0;
function fitView(force = false) {
  const w = innerWidth, h = innerHeight;
  if (w < 2 || h < 2 || (!force && w === viewW && h === viewH)) return;
  viewW = w; viewH = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  env.resize(w, h);
}
addEventListener('resize', fitView);

swordCtl.teleport(V(0.04, 1.1, -0.42), idleQuat);
{ const t0 = swordBody.translation(), r0 = swordBody.rotation(); swPrev.p.set(t0.x, t0.y, t0.z); swPrev.q.set(r0.x, r0.y, r0.z, r0.w); }
const qual = new Quality({ renderer, env, fitView, mode: quality });
{
  const gfx = { mode: qual.mode };
  const QOPTS = { '자동': 'auto', '높음': 'high', '중간': 'medium', '낮음': 'low' };
  gui.add(gfx, 'mode', QOPTS).name('화질').onChange((m) => {
    qual.setMode(m);
    try { localStorage.setItem(GFX_STORE, JSON.stringify({ mode: m })); } catch {}
  });
}
last = virtualNow;
if (!MANUAL) schedule(frame);

// debugging / automated QA handle
window.game = {
  THREE, RAPIER, world, env, drills, blockDrill, sim, ctrl, net, targets, swordCtl, swordBody, fx, flow, player, camera, scene, goStation, toast, enterGame, hud, perf, renderer, qual,
  /** hand (grip) target in the body frame, for QA */
  handBody: () => tgtBody.pos.clone(),
  now: () => virtualNow,
  swordMeshPos: () => swordMesh.position.clone(),
  swordMeshQuat: () => swordMesh.quaternion.clone(),
  /** ?manual mode: advance the virtual clock by ms in 60 Hz frames (renders the last one). */
  advance(ms, step = 1000 / 60) {
    for (let t = 0; t < ms; t += step) { virtualNow += step; tick(virtualNow, t + step >= ms); }
  },
  pause(v = true) {
    if (v && !paused) pausedAt = performance.now();
    if (!v && paused) { pausedAccum += performance.now() - pausedAt; last = performance.now() - pausedAccum; }
    paused = v;
  },
};
