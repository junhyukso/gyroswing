// Procedural longsword: render mesh + physics collider descriptions.
// Sword frame: origin = right-hand grip point, +y = blade toward tip, +x = true edge, +z = flat normal.
import * as THREE from 'three';

export const SWORD = {
  bladeStart: 0.07,
  tip: 1.02,
  baseWidth: 0.026,   // half width at the base
  rightHand: -0.005,
  leftHand: -0.125,
  guardY: 0.056,
  pommelY: -0.235,
};

function widthAt(u) {
  // u: 0 at blade base, 1 at tip. Gentle taper, then the point.
  const w0 = SWORD.baseWidth, w1 = 0.016;
  if (u < 0.86) return w0 + (w1 - w0) * (u / 0.86);
  const k = (u - 0.86) / 0.14;
  return w1 * Math.sqrt(Math.max(0, 1 - k * k)) * (1 - k * 0.15);
}
function thickAt(u) { return 0.0036 + (0.0018 - 0.0036) * u; }

function brushedTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#7a7a7a';
  g.fillRect(0, 0, 64, 512);
  for (let i = 0; i < 1800; i++) {
    const v = 90 + Math.random() * 90;
    g.fillStyle = `rgba(${v},${v},${v},0.25)`;
    g.fillRect(Math.random() * 64, Math.random() * 512, 1, 6 + Math.random() * 60);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function leatherTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#3a2416';
  g.fillRect(0, 0, 128, 256);
  // spiral wrap
  g.strokeStyle = 'rgba(15,8,4,0.85)';
  g.lineWidth = 3;
  for (let y = -256; y < 512; y += 22) { g.beginPath(); g.moveTo(0, y); g.lineTo(128, y + 60); g.stroke(); }
  for (let i = 0; i < 2500; i++) {
    const v = Math.random() * 40;
    g.fillStyle = `rgba(${80 + v},${50 + v * 0.6},${30 + v * 0.4},0.18)`;
    g.fillRect(Math.random() * 128, Math.random() * 256, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function bladeGeometry() {
  const N = 48;
  const sec = (u) => {
    const w = widthAt(u), t = thickAt(u);
    // flattened hexagon: edges at ±x, flats at ±z
    return [[w, 0], [w * 0.38, t], [-w * 0.38, t], [-w, 0], [-w * 0.38, -t], [w * 0.38, -t]];
  };
  const pos = [], uv = [];
  const y0 = SWORD.bladeStart, y1 = SWORD.tip;
  for (let i = 0; i < N; i++) {
    const ua = i / N, ub = (i + 1) / N;
    const A = sec(ua), B = sec(ub);
    const ya = y0 + (y1 - y0) * ua, yb = y0 + (y1 - y0) * ub;
    for (let k = 0; k < 6; k++) {
      const k2 = (k + 1) % 6;
      const a0 = [A[k][0], ya, A[k][1]], a1 = [A[k2][0], ya, A[k2][1]];
      const b0 = [B[k][0], yb, B[k][1]], b1 = [B[k2][0], yb, B[k2][1]];
      pos.push(...a0, ...b0, ...a1, ...a1, ...b0, ...b1);
      const u0 = k / 6, u1 = (k + 1) / 6;
      uv.push(u0, ua, u0, ub, u1, ua, u1, ua, u0, ub, u1, ub);
    }
  }
  // base cap
  const A = sec(0);
  for (let k = 0; k < 6; k++) {
    const k2 = (k + 1) % 6;
    pos.push(0, y0, 0, A[k2][0], y0, A[k2][1], A[k][0], y0, A[k][1]);
    uv.push(0.5, 0, 0, 0, 1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}

export function buildSwordMesh(opts = {}) {
  const group = new THREE.Group();
  group.name = 'sword';
  const brushed = brushedTexture();
  const steel = new THREE.MeshStandardMaterial({
    color: 0xd9dde2, metalness: 1, roughness: 0.2, roughnessMap: brushed, envMapIntensity: 1.15,
  });
  const darkSteel = new THREE.MeshStandardMaterial({ color: 0x8d9096, metalness: 1, roughness: 0.38, roughnessMap: brushed });
  const leatherMap = leatherTexture();
  const leather = new THREE.MeshStandardMaterial({ map: leatherMap, roughness: 0.85, metalness: 0 });

  const blade = new THREE.Mesh(bladeGeometry(), steel);
  blade.name = 'blade';
  group.add(blade);

  // crossguard: center block + two arms flaring slightly
  const guard = new THREE.Group();
  const block = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.026, 0.03), darkSteel);
  guard.add(block);
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.0105, 0.085, 4, 10), darkSteel);
    arm.rotation.z = Math.PI / 2 + s * 0.05;
    arm.position.set(s * 0.068, 0.002, 0);
    guard.add(arm);
  }
  guard.position.y = SWORD.guardY;
  group.add(guard);

  // grip (slight swell)
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const u = i / 12;
    pts.push(new THREE.Vector2(0.0145 + Math.sin(u * Math.PI) * 0.0022, -0.205 + u * 0.247));
  }
  const grip = new THREE.Mesh(new THREE.LatheGeometry(pts, 20), leather);
  grip.material.map.repeat.set(1, 1.6);
  group.add(grip);

  // wheel pommel (axis along the flat normal)
  const pommel = new THREE.Mesh(new THREE.CylinderGeometry(0.029, 0.029, 0.024, 28), darkSteel);
  pommel.rotation.x = Math.PI / 2;
  pommel.position.y = SWORD.pommelY;
  group.add(pommel);
  const peen = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.012, 10), darkSteel);
  peen.position.y = SWORD.pommelY - 0.033;
  group.add(peen);

  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = !opts.ghost; } });
  if (opts.ghost) {
    const ghostMat = new THREE.MeshBasicMaterial({ color: opts.color ?? 0x66ccff, transparent: true, opacity: opts.opacity ?? 0.22, depthWrite: false });
    if (opts.hands) {
      // where the hands go on the hilt
      for (const y of [SWORD.rightHand, SWORD.leftHand]) {
        const h = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.085, 0.08), ghostMat);
        h.position.y = y;
        group.add(h);
      }
    }
    group.traverse((o) => { if (o.isMesh) { o.material = ghostMat; o.castShadow = false; o.userData.noAO = true; } });
    group.userData.ghostMat = ghostMat;
  }
  return group;
}

/** Rapier collider descriptions for the sword body. */
export function swordColliders(RAPIER) {
  const s = SWORD;
  const bladePts = new Float32Array([
    s.baseWidth, s.bladeStart, 0, -s.baseWidth, s.bladeStart, 0, 0, s.bladeStart, 0.0042, 0, s.bladeStart, -0.0042,
    0.017, 0.86, 0, -0.017, 0.86, 0, 0, 0.86, 0.003, 0, 0.86, -0.003,
    0, s.tip, 0,
  ]);
  const blade = RAPIER.ColliderDesc.convexHull(bladePts).setMass(0.8).setFriction(0.35).setRestitution(0.05);
  const guard = RAPIER.ColliderDesc.cuboid(0.112, 0.011, 0.014).setTranslation(0, s.guardY, 0).setMass(0.25).setFriction(0.5);
  const grip = RAPIER.ColliderDesc.capsule(0.105, 0.016).setTranslation(0, -0.08, 0).setMass(0.1);
  const pommel = RAPIER.ColliderDesc.ball(0.029).setTranslation(0, s.pommelY, 0).setMass(0.3).setFriction(0.5);
  return { blade, guard, grip, pommel };
}
