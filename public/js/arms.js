// First-person arms: two-bone IK from the shoulders to the hands on the (physical) sword hilt,
// plus a shadow-only body so the player casts a shadow on the sand.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { SWORD } from './sword.js';

const UP = new THREE.Vector3(0, 1, 0);
const _u = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();

function limb(r0, r1, mat) {
  const g = new THREE.CylinderGeometry(r1, r0, 1, 14, 1);
  g.translate(0, 0.5, 0);
  const m = new THREE.Mesh(g, mat);
  m.castShadow = true;
  return m;
}

function segDist(p, a, b) {
  _u.subVectors(b, a);
  const t = Math.max(0, Math.min(1, _p.subVectors(p, a).dot(_u) / Math.max(_u.lengthSq(), 1e-9)));
  return _p.copy(a).addScaledVector(_u, t).distanceTo(p);
}

/** Limbs that come close to the eye fade out instead of filling the screen. */
function fade(mesh, dist) {
  const x = Math.max(0, Math.min(1, (dist - 0.15) / 0.07));
  const a = x * x * (3 - 2 * x);
  mesh.userData.alpha = a;
  const m = mesh.material;
  const transparent = a < 0.999;
  if (m.transparent !== transparent) { m.transparent = transparent; m.needsUpdate = true; }
  m.opacity = a;
  m.depthWrite = !transparent;
}

function place(mesh, a, b) {
  _u.subVectors(b, a);
  const len = _u.length();
  mesh.position.copy(a);
  mesh.quaternion.setFromUnitVectors(UP, _u.multiplyScalar(1 / Math.max(len, 1e-6)));
  mesh.scale.set(1, len, 1);
}

export class Arms {
  constructor(scene) {
    // each mesh gets its own material so it can fade independently near the camera
    const sleeve = () => new THREE.MeshStandardMaterial({ color: 0x3b332b, roughness: 0.95 });
    const bracer = () => new THREE.MeshStandardMaterial({ color: 0x3a2617, roughness: 0.7 });
    const glove = () => new THREE.MeshStandardMaterial({ color: 0x24180f, roughness: 0.6 });
    this.L1 = 0.30; this.L2 = 0.28;
    this.sides = ['R', 'L'].map((id) => {
      const upper = limb(0.056, 0.046, sleeve());
      const fore = limb(0.044, 0.034, bracer());
      const hand = new THREE.Mesh(new RoundedBoxGeometry(0.075, 0.09, 0.085, 3, 0.025), glove());
      hand.castShadow = true;
      const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.048, 12, 8), sleeve());
      scene.add(upper, fore, hand, elbow);
      return { id, upper, fore, hand, elbow, E: new THREE.Vector3(), W: new THREE.Vector3() };
    });
    // shadow-only body
    const shadowMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    this.body = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.55, 4, 10), shadowMat);
    torso.position.y = 1.2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), shadowMat);
    head.position.y = 1.68;
    const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.75, 4, 8), shadowMat);
    legs.position.y = 0.5;
    for (const m of [torso, head, legs]) { m.castShadow = true; this.body.add(m); }
    scene.add(this.body);
    this.visible = true;
  }

  /** Solve elbow for shoulder S, wrist target T, pole direction (world). */
  solve(S, T, pole, E, W) {
    const L1 = this.L1, L2 = this.L2;
    _u.subVectors(T, S);
    let d = _u.length();
    _u.multiplyScalar(1 / Math.max(d, 1e-6));
    d = Math.max(Math.abs(L1 - L2) + 0.01, Math.min(L1 + L2 - 0.002, d));
    const cosA = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    _p.copy(pole).addScaledVector(_u, -pole.dot(_u));
    if (_p.lengthSq() < 1e-6) _p.set(0, -1, 0);
    _p.normalize();
    E.copy(S).addScaledVector(_u, L1 * cosA).addScaledVector(_p, L1 * sinA);
    W.copy(S).addScaledVector(_u, d);
  }

  /**
   * playerPos/yawQuat: body transform. swordPos/swordQuat: physical sword pose (world).
   */
  update(playerPos, yawQuat, swordPos, swordQuat, camPos = null) {
    this.body.position.copy(playerPos);
    this.body.quaternion.copy(yawQuat);
    const axisY = new THREE.Vector3(0, 1, 0).applyQuaternion(swordQuat);
    const axisX = new THREE.Vector3(1, 0, 0).applyQuaternion(swordQuat);
    for (const s of this.sides) {
      const right = s.id === 'R';
      const S = new THREE.Vector3(right ? 0.19 : -0.19, 1.43, 0.02).applyQuaternion(yawQuat).add(playerPos);
      const handC = swordPos.clone().addScaledVector(axisY, right ? SWORD.rightHand : SWORD.leftHand);
      // wrist sits a little behind the fist toward the shoulder
      const toS = S.clone().sub(handC).normalize();
      const T = handC.clone().addScaledVector(toS, 0.065);
      const pole = new THREE.Vector3(right ? 0.7 : -0.7, -1, 0.35).applyQuaternion(yawQuat);
      this.solve(S, T, pole, s.E, s.W);
      place(s.upper, S, s.E);
      place(s.fore, s.E, s.W);
      s.elbow.position.copy(s.E);
      s.hand.position.copy(handC).addScaledVector(axisX, -0.006);
      s.hand.quaternion.copy(swordQuat);
      if (camPos) {
        fade(s.upper, segDist(camPos, S, s.E));
        fade(s.fore, segDist(camPos, s.E, s.W));
        fade(s.elbow, camPos.distanceTo(s.E));
        fade(s.hand, camPos.distanceTo(s.hand.position) - 0.03);
      }
      for (const m of [s.upper, s.fore, s.hand, s.elbow]) m.visible = this.visible && !this.calibHide && m.userData.alpha > 0.02;
    }
  }
}
