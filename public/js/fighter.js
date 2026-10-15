// A duelist: a kinematic body with hit zones (torso, head), a physical sword driven by the same
// force-limited servo as single player, and what the players see — the knight the OTHER player looks at
// (body + arms on the hilt) and the first-person arms its own player looks at.
//
// Views and layers: player i's camera renders layers 0 and 1+i. A fighter's knight goes on the other
// camera's layer, its first-person arms on its own; the swords are on both (minus the owner's while it
// calibrates — copying the gold sword must not be biased by the live one).
import * as THREE from 'three';
import { buildSwordMesh, swordColliders, SWORD } from './sword.js';
import { SwordController } from './swordctl.js';
import { GROUPS, groups, woodTexture } from './world.js';
import { Arms } from './arms.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export const layerOf = (i) => 1 + i;  // the layer only player i's camera sees
// Rapier membership bits for the duel (GROUPS uses the low six)
export const DUEL = { SWORD: [1 << 6, 1 << 7], BODY: [1 << 8, 1 << 9] };
export const TEAM = [
  { name: '1P', color: 0x2f5fb8, css: '#5b8cff' },
  { name: '2P', color: 0xb8322f, css: '#ff6a5b' },
];
export const EYE = V(0, 1.62, -0.07);  // body frame

export function setLayers(obj, ...layers) {
  obj.traverse((o) => { o.layers.disableAll(); for (const l of layers) o.layers.enable(l); });
}

export class Fighter {
  /** physics: false on a guest page (it only draws what the host sends). */
  constructor({ i, scene, RAPIER, world, physics = true }) {
    this.i = i;
    this.team = TEAM[i];
    this.pos = V(0, 0, i === 0 ? 0.9 : -0.9);
    this.base = this.pos.clone(); // where the feet stand (pos = base + a lunge toward the other)
    this.lunge = 0;
    this.yaw = i === 0 ? 0 : Math.PI;
    this.yawQ = new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), this.yaw);
    this.vel = V(); this.yawRate = 0;
    this.hp = 100;
    this.hitCooldown = 0;
    this.calibrating = false;
    this.collide = true;
    this.swPrev = { p: V(), q: new THREE.Quaternion() }; // sword before the last physics step (render interpolation)
    this.snap = { grip: V(), axisX: V(), axisY: V(), com: V(), linvel: V(), angvel: V() };
    this.involvement = 1;
    this.tipSpeed = 0;
    if (physics) this._buildPhysics(RAPIER, world);
    this._buildVisuals(scene);
  }

  // ------------------------------------------------------------------ physics (host)
  _buildPhysics(R, world) {
    this.R = R; this.world = world;
    const o = 1 - this.i;
    this.body = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(this.pos.x, 1.0, this.pos.z));
    this.zones = new Map(); // collider handle -> 'torso' | 'head'
    for (const [zone, desc] of [
      ['torso', R.ColliderDesc.capsule(0.22, 0.2).setTranslation(0, 0.12, 0)],
      ['head', R.ColliderDesc.ball(0.12).setTranslation(0, 0.64, 0.03)],
    ]) {
      const c = world.createCollider(desc.setCollisionGroups(groups(DUEL.BODY[this.i], DUEL.SWORD[o]))
        .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS)
        .setActiveCollisionTypes(R.ActiveCollisionTypes.DEFAULT | R.ActiveCollisionTypes.KINEMATIC_FIXED), this.body);
      this.zones.set(c.handle, zone);
    }
    const start = this.gripWorld(V(0.04, 1.1, -0.42));
    this.swordBody = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(start.x, start.y, start.z)
      .setCcdEnabled(true).setCanSleep(false));
    this.swordCols = new Map(); // collider handle -> part
    for (const [k, d] of Object.entries(swordColliders(R))) {
      d.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
      const c = world.createCollider(d, this.swordBody);
      this.swordCols.set(c.handle, k);
    }
    this.setCollide(true);
    this.ctl = new SwordController(R, world, this.swordBody);
    this.ctl.params.rescueTime = 2.0; // blades binding against each other is legitimate
    this.ctl.teleport(start, this.yawQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -1.2)));
    this.storePrev();
  }

  /** Sword collisions: off while this player calibrates or the fighters are being placed. */
  setCollide(on) {
    if (!this.swordCols) return;
    this.collide = on;
    const o = 1 - this.i;
    const filter = on ? GROUPS.STATIC | DUEL.SWORD[o] | DUEL.BODY[o] : GROUPS.STATIC;
    for (const h of this.swordCols.keys()) this.world.getCollider(h).setCollisionGroups(groups(DUEL.SWORD[this.i], filter));
  }

  gripWorld(local, out = V()) { return out.copy(local).applyQuaternion(this.yawQ).add(this.pos); }

  /** Body-frame target (controller output) -> the servo's world target, carried by the body's motion. */
  setTarget(tb) {
    const T = this.ctl.target;
    T.pos.copy(tb.pos).applyQuaternion(this.yawQ).add(this.pos);
    T.quat.copy(this.yawQ).multiply(tb.quat);
    T.w.copy(tb.w).applyQuaternion(this.yawQ);
    T.v.copy(tb.v).applyQuaternion(this.yawQ);
    T.v.add(this.vel).add(V(0, this.yawRate, 0).cross(V().subVectors(T.pos, this.pos)));
    T.w.y += this.yawRate;
  }

  /** Place the body (feet position + facing) for this frame. */
  place(pos, yaw, dt) {
    if (dt > 0) {
      this.vel.subVectors(pos, this.pos).multiplyScalar(1 / dt);
      let d = yaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yawRate = d / dt;
      this.yaw += d;
    } else this.yaw = yaw;
    this.pos.copy(pos);
    this.yawQ.setFromAxisAngle(V(0, 1, 0), this.yaw);
    this.body?.setNextKinematicTranslation({ x: pos.x, y: pos.y + 1.0, z: pos.z });
    this.body?.setNextKinematicRotation(this.yawQ);
  }

  /** Teleport body and sword (round start). */
  reset(pos, yaw, tb) {
    this.base.copy(pos); this.lunge = 0;
    this.place(pos, yaw, 0);
    this.vel.set(0, 0, 0); this.yawRate = 0;
    this.body?.setTranslation({ x: pos.x, y: pos.y + 1.0, z: pos.z }, true);
    this.body?.setRotation(this.yawQ, true);
    if (this.ctl && tb) { this.setTarget(tb); this.ctl.teleport(this.ctl.target.pos, this.ctl.target.quat); this.storePrev(); }
  }

  storePrev() {
    const r = this.swordBody.rotation(), t = this.swordBody.translation();
    this.swPrev.p.set(t.x, t.y, t.z); this.swPrev.q.set(r.x, r.y, r.z, r.w);
  }

  /** Sword state before a step (velocities for hit and clash judgement). */
  snapshot() {
    const b = this.swordBody, s = this.snap;
    const t = b.translation(), r = b.rotation(), c = b.worldCom(), lv = b.linvel(), av = b.angvel();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    s.grip.set(t.x, t.y, t.z);
    s.axisX.set(1, 0, 0).applyQuaternion(q); s.axisY.set(0, 1, 0).applyQuaternion(q);
    s.com.set(c.x, c.y, c.z); s.linvel.set(lv.x, lv.y, lv.z); s.angvel.set(av.x, av.y, av.z);
    return s;
  }

  /** Velocity of a point of the sword from the pre-step snapshot. */
  pointVel(p, out = V()) {
    const s = this.snap;
    return out.subVectors(p, s.com).cross(s.angvel).negate().add(s.linvel); // ω × r + v
  }

  // ------------------------------------------------------------------ visuals
  _buildVisuals(scene) {
    const own = layerOf(this.i), other = layerOf(1 - this.i);
    this.swordMesh = buildSwordMesh();
    scene.add(this.swordMesh);
    setLayers(this.swordMesh, own, other);
    // first-person arms (own camera)
    this.fp = new Arms(scene);
    for (const s of this.fp.sides) for (const m of [s.upper, s.fore, s.hand, s.elbow]) setLayers(m, own);
    setLayers(this.fp.body, own);
    // the knight the other player sees
    this.knight = this._buildKnight();
    scene.add(this.knight);
    setLayers(this.knight, other);
    this.kArms = new Arms(scene);
    this.kArms.body.visible = false;
    const cloth = new THREE.Color(this.team.color).multiplyScalar(0.8);
    for (const s of this.kArms.sides) {
      s.upper.material.color.copy(cloth); s.elbow.material.color.copy(cloth);
      s.fore.material.color.set(0x55575c); s.fore.material.metalness = 0.7; s.fore.material.roughness = 0.4;
      for (const m of [s.upper, s.fore, s.hand, s.elbow]) setLayers(m, other);
    }
    this.layers = { own, other };
  }

  _buildKnight() {
    const wood = new THREE.MeshStandardMaterial({ map: woodTexture([110, 92, 70], 5 + this.i), roughness: 0.85 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x5a5d63, metalness: 0.85, roughness: 0.35 });
    const cloth = new THREE.MeshStandardMaterial({ color: this.team.color, roughness: 0.9, side: THREE.DoubleSide });
    const g = new THREE.Group();
    const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; g.add(m); return m; };
    for (const sx of [-0.11, 0.11]) add(new THREE.CylinderGeometry(0.075, 0.065, 0.86, 10), wood, sx, 0.43, 0);
    add(new THREE.BoxGeometry(0.36, 0.18, 0.22), cloth, 0, 0.92, 0);
    add(new THREE.CylinderGeometry(0.2, 0.17, 0.6, 16), iron, 0, 1.22, 0);           // breastplate
    add(new THREE.BoxGeometry(0.48, 0.1, 0.24), iron, 0, 1.48, 0);                   // shoulders
    add(new THREE.PlaneGeometry(0.36, 0.62), cloth, 0, 1.1, -0.205);                  // tabard front (local -z = front)
    add(new THREE.PlaneGeometry(0.36, 0.62), cloth, 0, 1.1, 0.205).rotation.y = Math.PI;
    add(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 10), wood, 0, 1.56, 0);          // neck
    const helm = add(new THREE.CylinderGeometry(0.125, 0.13, 0.26, 18), iron, 0, 1.69, 0.03);
    const slit = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.018, 0.02), new THREE.MeshBasicMaterial({ color: 0x050505 }));
    slit.position.set(0, 0.03, -0.125);
    helm.add(slit);
    add(new THREE.CylinderGeometry(0.13, 0.125, 0.03, 18), iron, 0, 1.83, 0.03);
    const plume = add(new THREE.BoxGeometry(0.035, 0.12, 0.2), cloth, 0, 1.9, 0.06);  // crest in the team colour
    plume.castShadow = false;
    return g;
  }

  /**
   * Per drawn frame. swordPos/swordQuat: the sword as drawn; camPos / otherCamPos: this player's and the
   * other player's eye (arms close to a camera fade out); hideOwnSword: while copying the gold sword.
   */
  draw(swordPos, swordQuat, camPos, otherCamPos, hideOwnSword = false) {
    this.swordMesh.position.copy(swordPos);
    this.swordMesh.quaternion.copy(swordQuat);
    if (hideOwnSword !== this._hidOwn) { this._hidOwn = hideOwnSword; setLayers(this.swordMesh, ...(hideOwnSword ? [this.layers.other] : [this.layers.own, this.layers.other])); }
    this.fp.calibHide = hideOwnSword;
    this.fp.update(this.pos, this.yawQ, swordPos, swordQuat, camPos);
    this.knight.position.copy(this.pos);
    this.knight.quaternion.copy(this.yawQ);
    this.kArms.update(this.pos, this.yawQ, swordPos, swordQuat, otherCamPos);
  }

  /** World eye position (body frame EYE). */
  eye(out = V()) { return out.copy(EYE).applyQuaternion(this.yawQ).add(this.pos); }

  /** World point of the sword tip (as drawn). */
  tip(out = V()) { return out.set(0, SWORD.tip, 0).applyQuaternion(this.swordMesh.quaternion).add(this.swordMesh.position); }
}
