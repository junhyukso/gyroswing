// Block drill ("막기 수련"): a wooden practice knight attacks with a real physical sword — driven by
// the same force-limited servo as the player's — so blades actually meet, bind and deflect.
// Levels change the warning time and how strong the attacker pushes: at level 1 just putting the
// blade in the way holds; at level 3 a static guard gets driven through and only a parry works.
import * as THREE from 'three';
import { ArmModel } from './armmodel.js';
import { SwordController } from './swordctl.js';
import { buildSwordMesh, swordColliders, SWORD } from './sword.js';
import { GROUPS, groups, woodTexture } from './world.js';
import { poseFromDir, logRot } from './orient.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const Vn = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
const smooth = (x) => { const c = Math.max(0, Math.min(1, x)); return c * c * c * (c * (c * 6 - 15) + 10); };
const GUIDE = 0x46d7ff;

export const BLOCK_ZONE = V(-5.5, 0, 4.8);    // player stands here, facing -z
const OPP_DIST = 1.8;                         // attacker's feet, in front of the player

// Attacks in the attacker's own frame (facing -z like the player's body frame): blade directions
// along the strike (edge leads), aimed zone, lunge (m). 'R' versions start over the attacker's right
// shoulder, i.e. they come at the player from the player's LEFT.
const ATTACKS = {
  overhead: { path: [Vn(0, 0.55, 0.85), Vn(0, 1, -0.2), Vn(0, 0.05, -1)], zone: 'head', lunge: 0.55 },
  diagR: { path: [Vn(0.5, 0.55, 0.7), Vn(0.45, 0.7, -0.55), Vn(-0.4, -0.05, -0.92)], zone: 'head', lunge: 0.55 },
  diagL: { path: [Vn(-0.5, 0.55, 0.7), Vn(-0.45, 0.7, -0.55), Vn(0.4, -0.05, -0.92)], zone: 'head', lunge: 0.55 },
  horizR: { path: [Vn(1, 0.05, 0.4), Vn(0.55, -0.05, -0.85), Vn(-0.6, -0.05, -0.8)], zone: 'torso', lunge: 0.35 },
  horizL: { path: [Vn(-1, 0.05, 0.4), Vn(-0.55, -0.05, -0.85), Vn(0.6, -0.05, -0.8)], zone: 'torso', lunge: 0.35 },
  thrust: { thrust: true, zone: 'torso', lunge: 0.55 },
};
const ORDER = ['overhead', 'diagR', 'horizL', 'diagL', 'horizR', 'thrust'];

export const LEVELS = [
  { name: '1단계 · 초급', windup: 0.95, strike: 0.5, pause: 1.6, force: 260, torque: 60, desc: '칼을 공격선에 두기만 해도 막힙니다' },
  { name: '2단계 · 중급', windup: 0.7, strike: 0.38, pause: 1.25, force: 450, torque: 140, desc: '손잡이 쪽으로, 칼끼리 직각에 가깝게 막으세요' },
  { name: '3단계 · 상급', windup: 0.5, strike: 0.3, pause: 1.0, force: 800, torque: 300, desc: '가만히 대면 밀립니다 — 마주 쳐내세요' },
  { name: '4단계 · 실전', windup: 0.45, strike: 0.28, pause: 0.7, force: 800, torque: 300, random: true, desc: '무작위 순서 · 연속 공격' },
];

function slerpDir(a, b, t, out = new THREE.Vector3()) {
  const d = Math.max(-1, Math.min(1, a.dot(b)));
  const ang = Math.acos(d);
  if (ang < 1e-5) return out.copy(a);
  const s = Math.sin(ang);
  return out.copy(a).multiplyScalar(Math.sin((1 - t) * ang) / s).addScaledVector(b, Math.sin(t * ang) / s).normalize();
}

/** Pose along a strike path: blade dir at u (0..1) with the edge leading. */
function pathPose(path, u, out = new THREE.Quaternion()) {
  const n = path.length - 1;
  const at = (y) => { y = Math.max(0, Math.min(n - 1e-6, y)); const k = Math.floor(y); return slerpDir(path[k], path[k + 1], y - k); };
  const x = u * n;
  const dir = at(x);
  const edge = at(x + 0.02).sub(at(x - 0.02));
  if (edge.lengthSq() < 1e-8) edge.set(0, -1, 0);
  return poseFromDir(dir, edge, out);
}

export class BlockDrill {
  constructor({ scene, RAPIER, world, targets, fx, toast, haptic }) {
    this.scene = scene; this.R = RAPIER; this.world = world; this.targets = targets; this.fx = fx; this.toast = toast; this.haptic = haptic;
    this.level = 0;
    this.active = false;
    this.time = 0;
    this.stats = LEVELS.map(() => ({ attacks: 0, blocked: 0, parried: 0, evaded: 0, hitHead: 0, hitTorso: 0 }));
    this.arm = new ArmModel();
    this.pos = BLOCK_ZONE.clone().add(V(0, 0, -OPP_DIST));  // attacker's feet (world)
    this.yawQ = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), Math.PI); // faces +z, toward the player
    this.state = 'idle';
    this.stateT = 0;
    this.attack = null;
    this.queue = [];
    this.result = null;
    this.order = 0;
    this.parrySpeed = 1.5; // m/s of the player's blade into the attacker's at contact
    this.parryWindow = 0.08; // s: a beat that peaked this shortly before contact still counts (phone lag)
    this.parryLever = 0.35;  // m along the blade where a wrist snap is measured for contacts nearer the hilt
    this._hist = [];
    this.guardQ = poseFromDir(Vn(0, 0.3, -1), V(0, -1, 0));
    targets.stations.push({ name: '막기 수련', pos: BLOCK_ZONE.clone(), yaw: 0 });
    this._buildBody();
    this._buildSword();
    this._buildGuide();
    this._buildPanel();
  }

  get lv() { return LEVELS[this.level]; }

  // ------------------------------------------------------------------ build
  _buildBody() {
    const R = this.R;
    const wood = new THREE.MeshStandardMaterial({ map: woodTexture([150, 112, 72], 9), roughness: 0.8 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x3d4046, metalness: 0.85, roughness: 0.4 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0x6e1a1a, roughness: 0.95, side: THREE.DoubleSide });
    const g = new THREE.Group();
    const add = (geo, mat, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.x = rx; m.castShadow = m.receiveShadow = true; g.add(m); return m; };
    for (const sx of [-0.11, 0.11]) add(new THREE.CylinderGeometry(0.07, 0.06, 0.86, 10), wood, sx, 0.43, 0);
    add(new THREE.BoxGeometry(0.34, 0.16, 0.2), wood, 0, 0.92, 0);
    add(new THREE.CylinderGeometry(0.2, 0.16, 0.56, 14), wood, 0, 1.22, 0);
    add(new THREE.BoxGeometry(0.46, 0.1, 0.22), wood, 0, 1.47, 0.0);           // shoulders
    add(new THREE.PlaneGeometry(0.34, 0.6), cloth, 0, 1.12, -0.205);            // tabard front (local -z = its front)
    add(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 10), wood, 0, 1.56, 0);    // neck
    const helm = add(new THREE.CylinderGeometry(0.125, 0.13, 0.26, 18), iron, 0, 1.69, 0);
    const slit = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.018, 0.02), new THREE.MeshBasicMaterial({ color: 0x050505 }));
    slit.position.set(0, 0.03, -0.125);
    helm.add(slit);
    add(new THREE.CylinderGeometry(0.13, 0.125, 0.03, 18), iron, 0, 1.83, 0);
    this.bodyGroup = g;
    this.scene.add(g);
    // arms (IK to the sword grip each frame)
    const limb = (r0, r1) => { const geo = new THREE.CylinderGeometry(r1, r0, 1, 10); geo.translate(0, 0.5, 0); const m = new THREE.Mesh(geo, wood); m.castShadow = true; this.scene.add(m); return m; };
    this.armsMesh = ['R', 'L'].map((id) => ({ id, upper: limb(0.05, 0.045), fore: limb(0.042, 0.036),
      hand: (() => { const h = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.09, 0.085), iron); h.castShadow = true; this.scene.add(h); return h; })() }));
    // physics: kinematic body so the player's sword can strike the dummy (it steps in on attacks)
    this.body = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(this.pos.x, 0, this.pos.z));
    const col = (desc) => {
      desc.setCollisionGroups(groups(GROUPS.TARGET, GROUPS.SWORD | GROUPS.DEBRIS));
      const c = this.world.createCollider(desc, this.body);
      this.targets.material.set(c.handle, 'wood');
      return c;
    };
    col(R.ColliderDesc.capsule(0.25, 0.19).setTranslation(0, 1.2, 0));
    col(R.ColliderDesc.ball(0.14).setTranslation(0, 1.7, 0));
  }

  _buildSword() {
    const R = this.R;
    this.swordBody = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(this.pos.x, 1.1, this.pos.z + 0.42)
      .setCcdEnabled(true).setCanSleep(false));
    this.swordHandles = new Map();
    for (const [k, d] of Object.entries(swordColliders(R))) {
      d.setCollisionGroups(groups(GROUPS.ENEMY, GROUPS.SWORD | GROUPS.PLAYER | GROUPS.STATIC)).setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
      const c = this.world.createCollider(d, this.swordBody);
      this.swordHandles.set(c.handle, k);
      this.targets.material.set(c.handle, 'metal');
    }
    this.ctl = new SwordController(R, this.world, this.swordBody);
    Object.assign(this.ctl.params, { rescueDist: 1.2, rescueTime: 1.0 });
    this.swordMesh = buildSwordMesh();
    this.scene.add(this.swordMesh);
    this._applyLevel();
    const q = this._worldQuat(this.guardQ, new THREE.Quaternion());
    this.ctl.teleport(this._worldPos(this.arm.baseGrip(V(0, 1, 0).applyQuaternion(this.guardQ), V()), 0, V()), q);
  }

  _buildGuide() {
    const mat = new THREE.MeshBasicMaterial({ color: GUIDE, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide });
    this.guideMat = mat;
    const arrow = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.04), mat);
    shaft.position.x = -0.05;
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.07); shape.lineTo(0.13, 0); shape.lineTo(0, -0.07); shape.closePath();
    const head = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
    head.position.x = 0.2;
    arrow.add(shaft, head);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.01, 8, 40), mat);
    for (const o of [shaft, head, ring]) { o.renderOrder = 8; o.userData.noAO = true; }
    this.arrow = arrow; this.ring = ring;
    this.scene.add(arrow, ring);
    arrow.visible = ring.visible = false;
  }

  _buildPanel() {
    const el = document.createElement('div');
    el.className = 'drillpanel hidden';
    el.innerHTML = `
      <div class="dhead"><span class="dname">막기 수련</span><span class="didx"></span></div>
      <div class="dsub"></div>
      <div class="dstats"></div>
      <div class="dsub dlast"></div>
      <div class="dhint">폰 탭 · N = 다음 단계 &nbsp; B = 이전</div>`;
    document.body.appendChild(el);
    this.panel = el;
    this._renderPanel();
  }

  _renderPanel() {
    const el = this.panel, lv = this.lv, st = this.stats[this.level];
    el.querySelector('.didx').textContent = lv.name;
    el.querySelector('.dsub').textContent = lv.desc;
    const ok = st.blocked + st.parried + st.evaded;
    el.querySelector('.dstats').innerHTML =
      `<div><b>${ok}</b> / ${st.attacks} 방어 · 막음 ${st.blocked} · 쳐냄 ${st.parried}${st.evaded ? ` · 피함 ${st.evaded}` : ''}</div>` +
      `<div>피격 ${st.hitHead + st.hitTorso} (머리 ${st.hitHead} · 몸통 ${st.hitTorso})</div>`;
    el.querySelector('.dlast').textContent = this.lastLine || '';
  }

  _applyLevel() {
    Object.assign(this.ctl.params, { maxForce: this.lv.force, maxTorque: this.lv.torque, kAng: 40, kLin: 30, maxCorrW: 12 });
  }

  setLevel(i) {
    this.level = (i + LEVELS.length) % LEVELS.length;
    this._applyLevel();
    this.state = 'idle'; this.stateT = 0; this.queue = [];
    this.lastLine = '';
    this._renderPanel();
    this.fx.sfx.play('tick');
    this.toast(`${this.lv.name} — ${this.lv.desc}`, 1800);
  }
  next() { this.setLevel(this.level + 1); }
  prev() { this.setLevel(this.level - 1); }

  // ------------------------------------------------------------------ frames
  _worldQuat(qLocal, out) { return out.copy(this.yawQ).multiply(qLocal); }
  _worldPos(local, lunge, out) { out.copy(local); out.z -= lunge; return out.applyQuaternion(this.yawQ).add(this.pos); }

  /** Attacker's intended blade pose (local), grip (local) and lunge at the current timeline point. */
  _pose(outQ, outGrip) {
    const lv = this.lv, a = this.attack, t = this.stateT;
    let lunge = 0, thrustReach = 0;
    if (this.state === 'windup' && a) {
      const u = smooth(t / this.windup);
      if (a.thrust) { outQ.copy(this.guardQ).slerp(poseFromDir(Vn(0, 0.1, -1), V(0, -1, 0)), u); thrustReach = -0.15 * u; }
      else outQ.copy(this.guardQ).slerp(pathPose(a.path, 0), u);
    } else if (this.state === 'strike' && a) {
      const u = smooth(t / lv.strike);
      if (a.thrust) { outQ.copy(poseFromDir(Vn(0, 0.02, -1), V(0, -1, 0))); thrustReach = -0.15 + 0.5 * u; }
      else pathPose(a.path, u, outQ);
      lunge = a.lunge * u;
    } else if ((this.state === 'recover' || this.state === 'stagger') && a) {
      const dur = this.state === 'stagger' ? 0.9 : 0.6;
      const u = smooth(t / dur);
      const from = this.recoverFrom || this.guardQ;
      outQ.copy(from).slerp(this.guardQ, u);
      lunge = (this.recoverLunge ?? a.lunge) * (1 - u);
      thrustReach = (this.recoverReach ?? 0) * (1 - u);
    } else outQ.copy(this.guardQ);
    const dir = V(0, 1, 0).applyQuaternion(outQ);
    this.arm.baseGrip(dir, outGrip);
    outGrip.z -= thrustReach;
    return lunge;
  }

  _startAttack() {
    const lv = this.lv;
    let key;
    if (this.queue.length) key = this.queue.shift();
    else if (lv.random) {
      key = ORDER[Math.floor(Math.random() * ORDER.length)];
      if (Math.random() < 0.35) this.queue.push(ORDER[Math.floor(Math.random() * ORDER.length)]); // combo follow-up
    } else { key = ORDER[this.order % ORDER.length]; this.order++; }
    this.attack = { key, ...ATTACKS[key] };
    this.windup = lv.random ? lv.windup * (0.8 + Math.random() * 0.5) : lv.windup;
    this.state = 'windup'; this.stateT = 0;
    this.result = { clash: null, hit: null, parried: false };
    this.attack.label = this._label();
    // side it comes from, as the player sees it (-1 left, 1 right, 0 overhead / thrust)
    this.attack.side = this.attack.thrust ? 0 : Math.abs(this._travel().x) < 0.3 ? 0 : -Math.sign(this._travel().x);
    this.onEvent?.({ ev: 'attack', key, label: this.attack.label, level: this.level, windup: this.windup });
    this._placeGuide();
    this.fx.sfx.play('tick');
    this.panel.querySelector('.dlast').textContent = `다음: ${this.attack.label}`;
  }

  /** Name the attack the way the player sees it coming. */
  _label() {
    const a = this.attack;
    if (a.thrust) return '찌르기';
    const d = this._travel();
    const from = { x: -d.x, y: -d.y };
    if (from.y > 0.75) return '정수리 내려베기';
    if (Math.abs(from.y) < 0.45) return from.x < 0 ? '왼쪽 수평베기' : '오른쪽 수평베기';
    return from.x < 0 ? '왼쪽 위 사선베기' : '오른쪽 위 사선베기';
  }

  /** Direction the blade travels through the target zone, in the player's frontal plane. */
  _travel() {
    const a = this.attack;
    const q0 = this._worldQuat(pathPose(a.path, 0.45), new THREE.Quaternion());
    const q1 = this._worldQuat(pathPose(a.path, 0.6), new THREE.Quaternion());
    const t0 = V(0, 0.9, 0).applyQuaternion(q0), t1 = V(0, 0.9, 0).applyQuaternion(q1);
    const d = t1.sub(t0);
    return new THREE.Vector2(d.x, d.y).normalize();
  }

  _placeGuide() {
    const a = this.attack;
    const zoneY = a.zone === 'head' ? 1.6 : 1.12;
    // 0.9 m out: closer than that, a body-height guide falls below the bottom of the view
    const c = V(BLOCK_ZONE.x, zoneY, BLOCK_ZONE.z - 0.9);
    if (a.thrust) { this.ring.position.copy(c); this.ring.visible = true; this.arrow.visible = false; return; }
    const d = this._travel();
    this.arrow.position.copy(c);
    this.arrow.rotation.set(0, 0, Math.atan2(d.y, d.x));
    this.arrow.visible = true; this.ring.visible = false;
  }

  _hideGuide() { this.arrow.visible = this.ring.visible = false; }

  /**
   * Height (m) the incoming attack will cross in front of the player — the arm model's block poses and
   * height assist are on while this isn't null (from the wind-up until the attack has gone back).
   */
  hint() {
    if (!this.active || !this.attack || this.state === 'idle') return null;
    const a = this.attack;
    // measured where each attack's blade passes the player's flank / front (attacker's own arm model)
    const y = a.thrust ? 1.1 : a.zone === 'torso' ? 1.0 : a.key === 'overhead' ? 1.75 : 1.65;
    return { y, side: a.side };
  }

  // ------------------------------------------------------------------ physics step (called per substep)
  step(h, playerPos, playerTarget = null) {
    this.time += h;
    { // pose before this physics step, for drawing between steps (update)
      const r = this.swordBody.rotation(), t = this.swordBody.translation();
      (this._prevP ||= V()).set(t.x, t.y, t.z);
      (this._prevQ ||= new THREE.Quaternion()).set(r.x, r.y, r.z, r.w);
    }
    if (playerTarget) {
      // short history of the player's INTENDED blade motion (the servo target: what the hand did —
      // the physics blade also moves when it's pushed and springs back, which is no beat), for parries
      this.playerTarget = playerTarget;
      const e = this._hist.length && this._hist[0].t < this.time - this.parryWindow ? this._hist.shift() : { com: V(), lin: V(), ang: V() };
      e.t = this.time; e.com.copy(playerTarget.pos); e.lin.copy(playerTarget.v); e.ang.copy(playerTarget.w);
      this._hist.push(e);
      while (this._hist.length && this._hist[0].t < this.time - this.parryWindow) this._hist.shift();
    }
    const near = Math.hypot(playerPos.x - BLOCK_ZONE.x, playerPos.z - BLOCK_ZONE.z) < 1.2;
    if (near !== this.active) {
      this.active = near;
      this.panel.classList.toggle('hidden', !near);
      if (!near) { this.state = 'idle'; this._hideGuide(); }
      else { this.state = 'idle'; this.stateT = -1.0; this.lastLine = ''; this._renderPanel(); }
    }
    this.stateT += h;
    const lv = this.lv;
    switch (this.state) {
      case 'idle': if (this.active && this.stateT > lv.pause) this._startAttack(); break;
      case 'windup': if (this.stateT >= this.windup) { this.state = 'strike'; this.stateT = 0; this.fx.sfx.play('swish', 0.8); } break;
      case 'strike': if (this.stateT >= lv.strike) this._toRecover('recover'); break;
      case 'recover': if (this.stateT >= 0.6) this._finishAttack(); break;
      case 'stagger': if (this.stateT >= 0.9) this._finishAttack(); break;
    }
    // drive the attacker's sword (per physics step: reused temporaries, no allocation)
    const S = this._s ||= { q: new THREE.Quaternion(), grip: V(), dq: new THREE.Quaternion(), prevPos: V(), prevQ: new THREE.Quaternion(), has: false, zero: V(), bp: V() };
    const lunge = this._pose(S.q, S.grip);
    const T = this.ctl.target;
    this._worldQuat(S.q, T.quat);
    this._worldPos(S.grip, lunge, T.pos);
    if (S.has) {
      T.v.subVectors(T.pos, S.prevPos).multiplyScalar(1 / h);
      logRot(S.dq.copy(S.prevQ).invert().premultiply(T.quat), T.w).multiplyScalar(1 / h);
    }
    S.prevPos.copy(T.pos); S.prevQ.copy(T.quat); S.has = true;
    this.ctl.params.maxTorque = this.state === 'stagger' ? lv.torque * 0.25 : lv.torque;
    this.ctl.step(h, -9.81);
    // body follows the lunge
    const bp = this._worldPos(S.zero, lunge, S.bp);
    this.body.setNextKinematicTranslation({ x: bp.x, y: 0, z: bp.z });
    this.bodyPos = bp;
  }

  _toRecover(kind) {
    const r = this.swordBody.rotation();
    // recover from where the blade actually is (it may have been stopped or knocked aside)
    this.recoverFrom = this.yawQ.clone().invert().multiply(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    const u = this.state === 'strike' ? smooth(this.stateT / this.lv.strike) : 1;
    this.recoverLunge = this.attack.lunge * u;
    // pull back from how far the thrust actually got (not from full reach, which would stab on)
    this.recoverReach = this.attack.thrust ? -0.15 + 0.5 * u : 0;
    this.state = kind; this.stateT = 0;
    this._hideGuide();
  }

  _finishAttack() {
    const r = this.result, st = this.stats[this.level];
    st.attacks++;
    let line;
    if (r.hit) {
      if (r.hit === 'head') st.hitHead++; else st.hitTorso++;
      const where = r.hit === 'head' ? '머리' : '몸통';
      line = r.clash ? `막았지만 밀려서 ${where} 피격 (막은 곳: ${r.clash.part})` : `${this.attack.label} — ${where} 피격`;
    } else if (r.parried) {
      st.parried++;
      line = `쳐냄! ${r.clash.part} · 각도 ${r.clash.angle.toFixed(0)}°`;
    } else if (r.clash) {
      st.blocked++;
      line = `막음 — ${r.clash.part} · 각도 ${r.clash.angle.toFixed(0)}°`;
    } else {
      st.evaded++;
      line = '피함 (칼이 닿지 않았어요)';
    }
    this.lastLine = line;
    this.onEvent?.({ ev: 'result', key: this.attack.key, line, hit: r.hit, parried: r.parried, clash: r.clash && { part: r.clash.part, angle: +r.clash.angle.toFixed(0), u: +r.clash.u.toFixed(2), drive: +r.clash.drive.toFixed(2) } });
    this._renderPanel();
    this.state = 'idle'; this.stateT = 0;
    this.recoverFrom = null; this.recoverLunge = null; this.recoverReach = null;
  }

  // ------------------------------------------------------------------ contacts (from main's event loop)
  /** Blade contact still matters: not met yet, or bound and a beat could still knock it away. */
  wantsClash() {
    if (!this.active || !this.result) return false;
    return this.result.clash ? !this.result.parried && this.state === 'strike' : this.state === 'strike' || this.state === 'recover';
  }

  /** Attacker blade met the player's sword. */
  onClash(point, playerSnap, now, normal = null) {
    if (!this.active || !this.result || (this.state !== 'strike' && this.state !== 'recover')) return;
    // already met: only a beat out of the bind (still pressing during the strike) can still change it
    const bind = !!this.result.clash;
    if (bind && (this.result.parried || this.state !== 'strike')) return;
    const pb = playerSnap.axisY;
    const ob = V(0, 1, 0).applyQuaternion(this.swordMesh.quaternion);
    const u = point.clone().sub(playerSnap.grip).dot(pb);
    const part = u < 0.45 ? '손잡이 쪽(강)' : u < 0.75 ? '칼 가운데' : '칼끝 쪽(약)';
    const angle = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(pb.dot(ob)))));
    // parry: the player's blade was driving INTO the incoming one (speed along the contact normal,
    // pointing from the player's blade to the attacker's) — a held guard has ~0, a beat has a lot.
    // (A sideways beat on a thrust is perpendicular to the thrust, so "against its motion" is wrong.)
    const vp = V().crossVectors(playerSnap.angvel, point.clone().sub(playerSnap.com)).add(playerSnap.linvel);
    const av = this.swordBody.angvel(), lv = this.swordBody.linvel(), c = this.swordBody.worldCom();
    const ve = V(av.x, av.y, av.z).cross(point.clone().sub(V(c.x, c.y, c.z))).add(V(lv.x, lv.y, lv.z));
    const into = normal || ve.clone().normalize().negate();
    // a beat met near the hilt: the phone can't show the arm pushing behind it, only the wrist snap, so
    // that snap also counts as if measured at mid-blade (parryLever)
    const pMid = playerSnap.grip.clone().addScaledVector(pb, Math.max(u, this.parryLever));
    // best drive now and over the last few ms: a beat that peaked just before contact was still a beat
    let drive = -Infinity;
    for (const e of this._hist) {
      for (const q of [point, pMid]) drive = Math.max(drive, V().crossVectors(e.ang, q.clone().sub(e.com)).add(e.lin).dot(into));
    }
    if (!Number.isFinite(drive)) drive = 0;
    const parried = drive > this.parrySpeed;
    if (bind && !parried) return;
    if (!bind || parried) this.result.clash = { part, angle, u, drive };
    this.fx.sfx.play('metal', Math.min(1.4, (vp.length() + ve.length()) / 7));
    this.fx.burst('spark', point, 14, null, 1.6);
    this.fx.hitStop(now, 45);
    this.fx.shake(0.008);
    this.haptic?.(parried ? 3 : 2);
    // a training partner yields to a good block at the lower levels; from level 3 it keeps driving
    // (physics decides) and only a parry knocks it back
    // (a thrust is met with the blade still pointing roughly forward, so it gets a smaller angle)
    const good = this.level === 0 || (this.level === 1 && u < 0.75 && angle > (this.attack.thrust ? 25 : 40));
    if (!bind && !parried && good && this.state === 'strike') {
      // a practice partner pulls the strike: the blade stops on the guard instead of sliding on in
      const lv = this.swordBody.linvel(), av = this.swordBody.angvel();
      this.swordBody.setLinvel({ x: lv.x * 0.2, y: lv.y * 0.2, z: lv.z * 0.2 }, true);
      this.swordBody.setAngvel({ x: av.x * 0.2, y: av.y * 0.2, z: av.z * 0.2 }, true);
      this._toRecover('recover');
    }
    if (parried) {
      this.result.parried = true;
      // knocked off line: the attacker staggers back to guard with a weak grip
      if (this.state === 'strike') this._toRecover('stagger');
      this.toast(`쳐냄! (${drive.toFixed(1)} m/s)`, 700);
    }
  }

  /** Attacker blade reached the player's body. zone: 'head' | 'torso' */
  onBodyHit(zone, now) {
    if (!this.active || !this.result || this.result.hit || (this.state !== 'strike' && this.state !== 'recover')) return false;
    this.result.hit = zone;
    if (this.state === 'strike') this._toRecover('recover');
    return true;
  }

  // ------------------------------------------------------------------ visuals (per frame)
  /** Per frame, after the physics steps. alpha: how far past the previous step to draw (interpolation). */
  update(dt, alpha = 1) {
    const r = this.swordBody.rotation(), t = this.swordBody.translation();
    this.swordMesh.position.set(t.x, t.y, t.z);
    this.swordMesh.quaternion.set(r.x, r.y, r.z, r.w);
    if (this._prevP) {
      this.swordMesh.position.lerp(this._prevP, 1 - alpha);
      const now = this.swordMesh.quaternion.clone();
      this.swordMesh.quaternion.copy(this._prevQ).slerp(now, alpha);
    }
    const bp = this.bodyPos || this.pos;
    this.bodyGroup.position.copy(bp);
    this.bodyGroup.quaternion.copy(this.yawQ);
    // arms: two-bone IK from the shoulders to the hilt
    const axisY = V(0, 1, 0).applyQuaternion(this.swordMesh.quaternion);
    const pole = (right) => V(right ? 0.7 : -0.7, -1, 0.3).applyQuaternion(this.yawQ);
    for (const a of this.armsMesh) {
      const right = a.id === 'R';
      const S = V(right ? 0.21 : -0.21, 1.45, 0).applyQuaternion(this.yawQ).add(bp);
      const hand = this.swordMesh.position.clone().addScaledVector(axisY, right ? SWORD.rightHand : SWORD.leftHand);
      const T = hand.clone().addScaledVector(S.clone().sub(hand).normalize(), 0.06);
      const E = ik(S, T, pole(right), 0.3, 0.28);
      place(a.upper, S, E); place(a.fore, E, T);
      a.hand.position.copy(hand);
      a.hand.quaternion.copy(this.swordMesh.quaternion);
    }
    this.guideMat.opacity = this.state === 'windup' ? 0.6 + 0.35 * Math.sin(this.time * 18) : 0.85;
  }
}

function ik(S, T, pole, L1, L2) {
  const u = T.clone().sub(S);
  let d = u.length();
  u.multiplyScalar(1 / Math.max(d, 1e-6));
  d = Math.max(Math.abs(L1 - L2) + 0.01, Math.min(L1 + L2 - 0.002, d));
  const cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const p = pole.clone().addScaledVector(u, -pole.dot(u)).normalize();
  return S.clone().addScaledVector(u, L1 * cosA).addScaledVector(p, L1 * sinA);
}

function place(mesh, a, b) {
  const d = b.clone().sub(a);
  const len = d.length();
  mesh.position.copy(a);
  mesh.quaternion.setFromUnitVectors(V(0, 1, 0), d.multiplyScalar(1 / Math.max(len, 1e-6)));
  mesh.scale.set(1, len, 1);
}
