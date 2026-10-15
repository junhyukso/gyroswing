// Calibration visuals: the gold target sword (with hand spots) and the aiming ring at the screen centre.
import * as THREE from 'three';
import { buildSwordMesh, SWORD } from './sword.js';

export function buildCalGhost() {
  const calGhost = buildSwordMesh({ ghost: true, color: 0xffc94a, opacity: 0.5, hands: true });
  // a thick glowing core along the blade and a ball on the tip, so the pose reads at a glance
  const m = calGhost.userData.ghostMat;
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.026, SWORD.tip - 0.07, 12), m);
  core.position.y = (SWORD.tip + 0.07) / 2;
  const tipBall = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 10), m);
  tipBall.position.y = SWORD.tip;
  // pointer beam beyond the tip: makes the direction obvious in perspective
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xffc94a, transparent: true, opacity: 0.28, depthTest: false, depthWrite: false });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.012, 1.6, 8), beamMat);
  beam.position.y = SWORD.tip + 0.8;
  calGhost.add(core, tipBall, beam);
  calGhost.userData.beamMat = beamMat;
  m.depthTest = false; // never hidden behind targets
  calGhost.visible = false;
  calGhost.renderOrder = 6;
  return calGhost;
}

export function buildCalRing() {
  const calRing = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xffc94a, transparent: true, opacity: 0.9, depthTest: false });
  calRing.add(new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.012, 8, 48), mat));
  calRing.add(new THREE.Mesh(new THREE.CircleGeometry(0.025, 20), mat));
  for (const a of [0, 1, 2, 3]) {
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.012, 0.08), mat);
    tick.position.set(Math.cos((a * Math.PI) / 2) * 0.22, Math.sin((a * Math.PI) / 2) * 0.22, 0);
    tick.rotation.z = (a * Math.PI) / 2 + Math.PI / 2;
    calRing.add(tick);
  }
  calRing.traverse((o) => { o.renderOrder = 7; o.userData.noAO = true; });
  calRing.visible = false;
  return calRing;
}
