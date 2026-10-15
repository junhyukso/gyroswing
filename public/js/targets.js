// Training targets: tatami mats (cuttable), pell, quintain, heavy bag.
// Cutting uses a Rapier contact-filter hook: when the blade meets a mat edge-first and fast
// enough, the contact is suppressed and the mat is sliced along the blade's swing plane.
import * as THREE from 'three';
import { GROUPS, groups, woodTexture } from './world.js';
import { slicePoints, pieceGeometry, pointsVolume } from './slicer.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const MAX_PIECES = 90;

function strawTextures() {
  const mk = (draw) => {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 512;
    draw(c.getContext('2d'), 256, 512);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  };
  const outer = mk((g, w, h) => {
    g.fillStyle = '#a89a5c'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * w, v = Math.random();
      g.strokeStyle = v < 0.5 ? `rgba(70,62,30,${0.15 + Math.random() * 0.25})` : `rgba(210,196,130,${0.15 + Math.random() * 0.3})`;
      g.lineWidth = 0.7 + Math.random() * 1.6;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (Math.random() - 0.5) * 6, h); g.stroke();
    }
    // binding cords
    for (const y of [0.18, 0.5, 0.82]) {
      g.fillStyle = 'rgba(60,40,20,0.85)'; g.fillRect(0, y * h, w, 6);
    }
  });
  const inner = mk((g, w, h) => {
    g.fillStyle = '#c9b977'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 6000; i++) {
      const r = 1 + Math.random() * 2.2;
      g.fillStyle = Math.random() < 0.3 ? 'rgba(80,90,40,0.5)' : 'rgba(235,220,160,0.6)';
      g.beginPath(); g.arc(Math.random() * w, Math.random() * h, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(60,50,25,0.55)';
      g.beginPath(); g.arc(Math.random() * w, Math.random() * h, r * 0.45, 0, Math.PI * 2); g.fill();
    }
  });
  return { outer, inner };
}

function cylinderPoints(r, h, seg = 22) {
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push(V(Math.cos(a) * r, -h / 2, Math.sin(a) * r), V(Math.cos(a) * r, h / 2, Math.sin(a) * r));
  }
  return pts;
}

export class Targets {
  constructor({ scene, RAPIER, world, fx }) {
    this.scene = scene;
    this.R = RAPIER;
    this.world = world;
    this.fx = fx;
    this.time = 0;
    // A cut needs the edge leading (alignment) and enough energy at the contact point: ½·m·v².
    // m is the effective mass behind the blade there — a wrist flick spins only the sword about the
    // wrist (light), a whole-arm swing puts the arm behind it (heavy). Involvement comes from the
    // controller's lever-radius estimate (0 = wrist only, 1 = whole arm).
    // cutEnergy is judged on the physical sword, which runs ~1.7x the target's energy (servo overshoot):
    // 70 J cuts 15/15 big arm swings and 2/42 wrist flicks from the user's iPhone (tools/physics-replay.mjs)
    this.params = { minCutSpeed: 4.0, minAlign: 0.74, cutEnergy: 70, mWrist: 0.35, mArm: 1.5 };
    this.material = new Map();     // collider handle -> 'wood' | 'straw' | 'metal' | 'leather' | 'ground' | 'player'
    this.pieces = new Map();       // collider handle -> piece
    this.synced = [];              // { body, mesh }
    this.cutQueue = [];
    this.sword = null;             // snapshot set by main before each step
    this.stats = { cuts: 0, lastAlign: 0, lastSpeed: 0, lastCut: null };
    const tex = strawTextures();
    this.matMaterials = [
      new THREE.MeshStandardMaterial({ map: tex.outer, roughness: 0.92 }),
      new THREE.MeshStandardMaterial({ map: tex.inner, roughness: 0.95 }),
    ];
    this.woodTex = woodTexture([128, 94, 60], 3);
    this.stations = [];
    this.matStands = [];
    this.springs = [];             // { body, k, c } angular springs toward upright
    this._build();
    this.hooks = {
      filterContactPair: (c1, c2) => this._filter(c1, c2),
      filterIntersectionPair: () => true,
    };
  }

  // ------------------------------------------------------------------ build
  _fixed(x, y, z) { return this.world.createRigidBody(this.R.RigidBodyDesc.fixed().setTranslation(x, y, z)); }

  _collider(desc, body, mat, member = GROUPS.TARGET) {
    desc.setCollisionGroups(groups(member, 0xffff));
    const c = this.world.createCollider(desc, body);
    this.material.set(c.handle, mat);
    return c;
  }

  _sync(body, mesh) {
    this.synced.push({ body, mesh });
    this.scene.add(mesh);
  }

  _build() {
    const R = this.R;
    const woodMat = new THREE.MeshStandardMaterial({ map: this.woodTex, roughness: 0.85 });
    const darkWood = new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.8 });
    const iron = new THREE.MeshStandardMaterial({ color: 0x55585e, metalness: 0.9, roughness: 0.45 });
    this.mats = { woodMat, darkWood, iron };

    // ---- station 1: three tatami mats on stands
    this.stations.push({ name: '짚단 베기', pos: V(0, 0, 0), yaw: 0 });
    for (const [x, z] of [[-0.6, -1.05], [0, -1.45], [0.6, -1.05]]) this.matStands.push(this._matStand(x, z, darkWood, iron));
    this.resetMats();

    // ---- station 2: pell (wooden post)
    {
      const x = -4, z = -2;
      this.stations.push({ name: '파벽 기둥', pos: V(x, 0, z + 1.25), yaw: 0 });
      const base = this._fixed(x, 0, z);
      const H = 1.75, r = 0.11;
      const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, H / 2, z).setAngularDamping(1.5));
      this._collider(R.ColliderDesc.cylinder(H / 2, r).setMass(45).setFriction(0.7), body, 'wood');
      this.world.createImpulseJoint(R.JointData.spherical(V(0, 0, 0), V(0, -H / 2, 0)), base, body, true).setContactsEnabled(false);
      this.springs.push({ body, k: 26000, c: 700 });
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.04, H, 18), woodMat);
      mesh.castShadow = mesh.receiveShadow = true;
      this._sync(body, mesh);
      this.pell = { body, mesh, marks: [] };
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 0.12, 20), darkWood);
      foot.position.set(x, 0.06, z);
      foot.receiveShadow = foot.castShadow = true;
      this.scene.add(foot);
    }

    // ---- station 3: quintain (spinning arm with a shield and a swinging bag)
    // Hit the shield off-center and the arm spins; the bag on the far end comes round at
    // chest height, so the player has to parry it with the blade or step back.
    {
      const x = 4, z = -2.6;
      const SH = 0.68, BAG = -1.7, SHY = -0.72, ROPE = 0.5; // arm-local layout
      this.stations.push({ name: '퀸테인', pos: V(x, 0, z + 1.95), yaw: 0 });
      const postH = 2.1;
      const post = this._fixed(x, postH / 2, z);
      this._collider(R.ColliderDesc.cylinder(postH / 2, 0.09), post, 'wood', GROUPS.STATIC);
      const pm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, postH, 14), woodMat);
      pm.position.set(x, postH / 2, z);
      pm.castShadow = pm.receiveShadow = true;
      this.scene.add(pm);
      const pivotY = 2.02;
      const arm = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, pivotY, z).setAngularDamping(0.25).setLinearDamping(0.1));
      const group = new THREE.Group();
      const beamLen = SH - BAG + 0.1, beamZ = (SH + BAG) / 2;
      this._collider(R.ColliderDesc.cuboid(0.045, 0.045, beamLen / 2).setTranslation(0, 0, beamZ).setMass(3.5), arm, 'wood');
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, beamLen), woodMat);
      beam.position.z = beamZ;
      group.add(beam);
      // hanger + shield board facing +z (toward the player)
      const hanger = new THREE.Mesh(new THREE.BoxGeometry(0.05, -SHY - 0.3, 0.05), darkWood);
      hanger.position.set(0, (SHY + 0.3) / 2, SH);
      group.add(hanger);
      this._collider(R.ColliderDesc.cuboid(0.025, (-SHY - 0.3) / 2, 0.025).setTranslation(0, (SHY + 0.3) / 2, SH).setMass(0.6), arm, 'wood');
      this._collider(R.ColliderDesc.cuboid(0.25, 0.3, 0.018).setTranslation(0, SHY, SH).setMass(2.2).setFriction(0.6), arm, 'wood');
      const shieldTex = new THREE.CanvasTexture((() => {
        const c = document.createElement('canvas'); c.width = 256; c.height = 320;
        const g = c.getContext('2d');
        g.fillStyle = '#e8dcc0'; g.fillRect(0, 0, 256, 320);
        g.fillStyle = '#7a1c1c'; g.fillRect(0, 0, 128, 160); g.fillRect(128, 160, 128, 160);
        g.strokeStyle = '#3a2a1a'; g.lineWidth = 10; g.strokeRect(5, 5, 246, 310);
        return c;
      })());
      shieldTex.colorSpace = THREE.SRGBColorSpace;
      const shield = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.036),
        [darkWood, darkWood, darkWood, darkWood, new THREE.MeshStandardMaterial({ map: shieldTex, roughness: 0.8 }), darkWood]);
      shield.position.set(0, SHY, SH);
      group.add(shield);
      const boss = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), iron);
      boss.rotation.x = Math.PI / 2;
      boss.position.set(0, SHY, SH + 0.02);
      group.add(boss);
      this._collider(R.ColliderDesc.ball(0.06).setTranslation(0, SHY, SH + 0.03).setMass(0.5), arm, 'metal');
      group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this._sync(arm, group);
      // pivot is at the post body's local y = pivotY - postH/2
      const rev = this.world.createImpulseJoint(R.JointData.revolute(V(0, pivotY - postH / 2, 0), V(0, 0, 0), V(0, 1, 0)), post, arm, true);
      rev.setContactsEnabled(false); // the beam sits on the post top
      rev.configureMotorVelocity(0, 0.015); // a little bearing friction
      // bag on a rope
      const bagR = 0.13, bagH = 0.3;
      const bag = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, pivotY - ROPE - bagH / 2, z + BAG).setLinearDamping(0.05).setAngularDamping(0.5));
      this._collider(R.ColliderDesc.capsule(bagH / 2, bagR).setMass(3).setRestitution(0.1), bag, 'leather');
      this.world.createImpulseJoint(R.JointData.spherical(V(0, 0, BAG), V(0, ROPE + bagH / 2, 0)), arm, bag, true);
      const bagMesh = new THREE.Mesh(new THREE.CapsuleGeometry(bagR, bagH, 6, 14), new THREE.MeshStandardMaterial({ color: 0x6b5236, roughness: 0.9 }));
      bagMesh.castShadow = true;
      this._sync(bag, bagMesh);
      const rope = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(), V()]), new THREE.LineBasicMaterial({ color: 0x2a2018 }));
      rope.frustumCulled = false;
      this.scene.add(rope);
      this.quintain = { arm, bag, rope, rev, bagTop: ROPE + bagH / 2, bagArm: BAG, home: { arm: V(x, pivotY, z), bag: V(x, pivotY - ROPE - bagH / 2, z + BAG) } };
    }

    // ---- station 4: heavy bag hanging from a frame
    {
      const x = -7.6, z = -1.6;
      this.stations.push({ name: '샌드백', pos: V(x, 0, z + 1.3), yaw: 0 });
      const frame = this._fixed(x, 0, z);
      for (const sx of [-0.9, 0.9]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.6, 0.12), woodMat);
        leg.position.set(x + sx, 1.3, z);
        leg.castShadow = true;
        this.scene.add(leg);
        this._collider(R.ColliderDesc.cuboid(0.06, 1.3, 0.06).setTranslation(sx, 1.3, 0), frame, 'wood', GROUPS.STATIC);
      }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(1.95, 0.12, 0.12), woodMat);
      bar.position.set(x, 2.6, z);
      bar.castShadow = true;
      this.scene.add(bar);
      const H = 0.9, r = 0.17;
      const bag = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, 2.55 - 0.7 - H / 2, z).setAngularDamping(1.2).setLinearDamping(0.15));
      this._collider(R.ColliderDesc.cylinder(H / 2, r).setMass(28).setFriction(0.8), bag, 'leather');
      this.world.createImpulseJoint(R.JointData.spherical(V(0, 2.55, 0), V(0, 0.7 + H / 2, 0)), frame, bag, true);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, H, 20), new THREE.MeshStandardMaterial({ color: 0x3d2b1d, roughness: 0.75 }));
      mesh.castShadow = true;
      this._sync(bag, mesh);
      const rope = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(), V()]), new THREE.LineBasicMaterial({ color: 0x2a2018 }));
      rope.frustumCulled = false;
      this.scene.add(rope);
      this.heavyBag = { body: bag, rope, top: V(x, 2.55, z), half: 0.7 + H / 2 };
    }
  }

  _matStand(x, z, darkWood, iron, rig = null) {
    const R = this.R;
    const standH = 0.78;
    const body = this._fixed(x, 0, z);
    this._collider(R.ColliderDesc.cylinder(0.02, 0.2).setTranslation(0, 0.02, 0), body, 'wood', GROUPS.STATIC);
    this._collider(R.ColliderDesc.cylinder(standH / 2, 0.022).setTranslation(0, standH / 2, 0), body, 'metal', GROUPS.STATIC);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.04, 20), darkWood);
    base.position.set(x, 0.02, z);
    const spike = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.024, standH, 10), iron);
    spike.position.set(x, standH / 2, z);
    for (const m of [base, spike]) { m.castShadow = m.receiveShadow = true; this.scene.add(m); rig?.meshes.push(m); }
    return { body, x, z, top: standH };
  }

  // ------------------------------------------------------------------ cuttable pieces
  _pieceMesh(points, h, r) {
    const geo = pieceGeometry(points, {
      isOuter: (n, c) => Math.abs(n.y) < 0.3 && Math.hypot(c.x, c.z) > r * 0.85,
      outerNormal: (p, out) => out.set(p.x, 0, p.z).normalize(),
      outerUV: (p) => [Math.atan2(p.z, p.x) / (Math.PI * 2) + 0.5, (p.y + h / 2) / h],
      cutUVScale: 5,
    });
    const mesh = new THREE.Mesh(geo, this.matMaterials);
    mesh.castShadow = mesh.receiveShadow = true;
    return mesh;
  }

  _spawnPiece(points, pos, quat, { attachTo = null, h, r, linvel = null, angvel = null, tag = 'yard' }) {
    const R = this.R;
    const body = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z)
      .setRotation(quat).setAngularDamping(0.4).setLinearDamping(0.05).setCcdEnabled(true));
    const flat = new Float32Array(points.length * 3);
    points.forEach((p, i) => { flat[i * 3] = p.x; flat[i * 3 + 1] = p.y; flat[i * 3 + 2] = p.z; });
    const desc = R.ColliderDesc.convexHull(flat);
    if (!desc) { this.world.removeRigidBody(body); return null; }
    desc.setDensity(420).setFriction(0.8).setRestitution(0.05).setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS)
      .setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    const col = this._collider(desc, body, 'straw');
    const mesh = this._pieceMesh(points, h, r);
    let joint = null;
    if (attachTo) {
      joint = this.world.createImpulseJoint(R.JointData.spherical(V(0, attachTo.top, 0), attachTo.anchorLocal), attachTo.body, body, true);
      joint.setContactsEnabled(false); // mat sits on the stand spike
      // spherical joints have no motors in rapier.js; an explicit angular spring keeps the mat upright
      const m = pointsVolume(points) * 420; // body.mass() isn't updated until the next step
      this.springs.push({ body, k: 70 * m, c: 2.3 * m });
    }
    if (linvel) body.setLinvel(linvel, true);
    if (angvel) body.setAngvel(angvel, true);
    const piece = { body, collider: col, mesh, points, joint, attachTo, h, r, passUntil: 0, born: this.time, tag };
    this.pieces.set(col.handle, piece);
    this._sync(body, mesh);
    return piece;
  }

  _removePiece(piece) {
    this.pieces.delete(piece.collider.handle);
    this.material.delete(piece.collider.handle);
    if (piece.joint) this.world.removeImpulseJoint(piece.joint, true);
    this.springs = this.springs.filter((sp) => sp.body !== piece.body);
    this.world.removeRigidBody(piece.body);
    this.scene.remove(piece.mesh);
    piece.mesh.geometry.dispose();
    this.synced = this.synced.filter((s) => s.body !== piece.body);
  }

  /** Put the quintain arm back facing the player, at rest. */
  resetQuintain() {
    const q = this.quintain;
    if (!q) return;
    const zero = { x: 0, y: 0, z: 0 };
    q.arm.setTranslation(q.home.arm, true); q.arm.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    q.arm.setLinvel(zero, true); q.arm.setAngvel(zero, true);
    q.bag.setTranslation(q.home.bag, true); q.bag.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    q.bag.setLinvel(zero, true); q.bag.setAngvel(zero, true);
  }

  resetAll() {
    this.resetMats();
    this.resetQuintain();
    for (const b of [this.pell?.body, this.heavyBag?.body]) if (b) { b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true); }
  }

  removeTagged(tag) {
    for (const p of [...this.pieces.values()]) if (p.tag === tag) this._removePiece(p);
  }

  piecesTagged(tag) { return [...this.pieces.values()].filter((p) => p.tag === tag); }

  // ------------------------------------------------------------------ drill rigs (built/removed on demand)
  _rig(kind) {
    const rig = { kind, bodies: [], meshes: [], dispose: () => {
      for (const b of rig.bodies) {
        for (let i = 0; i < b.numColliders(); i++) this.material.delete(b.collider(i).handle);
        this.world.removeRigidBody(b);
      }
      for (const m of rig.meshes) this.scene.remove(m);
    } };
    return rig;
  }
  _rigMesh(rig, mesh) { mesh.castShadow = mesh.receiveShadow = true; this.scene.add(mesh); rig.meshes.push(mesh); return mesh; }

  /** A spike stand for an upright mat. */
  createStandRig(x, z) {
    const rig = this._rig('stand');
    const st = this._matStand(x, z, this.mats.darkWood, this.mats.iron, rig);
    Object.assign(rig, st);
    rig.bodies.push(st.body);
    return rig;
  }

  /** Two cradles holding a mat lying left-right at chest height (for vertical cuts). */
  createRackRig(x, z, top = 1.0, span = 0.62) {
    const R = this.R;
    const rig = this._rig('rack');
    const body = this._fixed(x, 0, z);
    rig.bodies.push(body);
    for (const sx of [-span / 2, span / 2]) {
      this._collider(R.ColliderDesc.cuboid(0.035, top / 2, 0.035).setTranslation(sx, top / 2, 0), body, 'wood', GROUPS.STATIC);
      // V-cradle: two small blocks so the round mat can't roll off
      for (const sz of [-1, 1]) this._collider(R.ColliderDesc.cuboid(0.03, 0.03, 0.012).setTranslation(sx, top + 0.02, sz * 0.07), body, 'wood', GROUPS.STATIC);
      const post = this._rigMesh(rig, new THREE.Mesh(new THREE.BoxGeometry(0.07, top, 0.07), this.mats.woodMat));
      post.position.set(x + sx, top / 2, z);
      for (const sz of [-1, 1]) {
        const lip = this._rigMesh(rig, new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.024), this.mats.darkWood));
        lip.position.set(x + sx, top + 0.02, z + sz * 0.07);
      }
    }
    const foot = this._rigMesh(rig, new THREE.Mesh(new THREE.BoxGeometry(span + 0.2, 0.05, 0.3), this.mats.darkWood));
    foot.position.set(x, 0.025, z);
    Object.assign(rig, { body, x, z, top });
    return rig;
  }

  /** A round straw target facing the player (thrust drill). */
  createDiskRig(x, z, cy = 1.3, radius = 0.17) {
    const R = this.R;
    const rig = this._rig('disk');
    const body = this._fixed(x, 0, z);
    rig.bodies.push(body);
    const disk = this._collider(R.ColliderDesc.cylinder(0.04, radius).setTranslation(0, cy, 0)
      .setRotation(new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), Math.PI / 2)).setFriction(0.9), body, 'disk', GROUPS.STATIC);
    this._collider(R.ColliderDesc.cuboid(0.035, (cy - radius) / 2, 0.035).setTranslation(0, (cy - radius) / 2, -0.05), body, 'wood', GROUPS.STATIC);
    const tex = new THREE.CanvasTexture((() => {
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const g = c.getContext('2d');
      const rings = ['#cdbb7a', '#7a1c1c', '#cdbb7a', '#7a1c1c', '#e0a943'];
      rings.forEach((col, i) => { g.fillStyle = col; g.beginPath(); g.arc(128, 128, 128 - i * 25, 0, Math.PI * 2); g.fill(); });
      return c;
    })());
    tex.colorSpace = THREE.SRGBColorSpace;
    const face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 });
    const side = new THREE.MeshStandardMaterial({ color: 0xa89a5c, roughness: 0.95 });
    const m = this._rigMesh(rig, new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.08, 32), [side, face, face]));
    m.rotation.x = Math.PI / 2;
    m.position.set(x, cy, z);
    const post = this._rigMesh(rig, new THREE.Mesh(new THREE.BoxGeometry(0.07, cy - radius, 0.07), this.mats.woodMat));
    post.position.set(x, (cy - radius) / 2, z - 0.05);
    Object.assign(rig, { body, x, z, center: V(x, cy, z + 0.04), radius, diskHandle: disk.handle });
    return rig;
  }

  spawnStandingMat(stand, tag) {
    const h = 1.0, r = 0.062;
    return this._spawnPiece(cylinderPoints(r, h), V(stand.x, stand.top + h / 2, stand.z), new THREE.Quaternion(),
      { attachTo: { body: stand.body, top: stand.top, anchorLocal: V(0, -h / 2, 0) }, h, r, tag });
  }

  spawnLyingMat(rack, tag) {
    const h = 0.9, r = 0.062;
    const q = new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), Math.PI / 2); // cylinder axis along x
    return this._spawnPiece(cylinderPoints(r, h), V(rack.x, rack.top + r + 0.012, rack.z), q, { h, r, tag });
  }

  resetMats() {
    this.removeTagged('yard');
    const h = 1.0, r = 0.062;
    for (const st of this.matStands) {
      const anchorLocal = V(0, -h / 2, 0);
      this._spawnPiece(cylinderPoints(r, h), V(st.x, st.top + h / 2, st.z), new THREE.Quaternion(),
        { attachTo: { body: st.body, top: st.top, anchorLocal }, h, r });
    }
    this.stats.cuts = 0;
  }

  // ------------------------------------------------------------------ cutting
  /** Called by main before each world.step with a plain snapshot of the sword. */
  setSwordSnapshot(s) { this.sword = s; }

  _filter(c1, c2) {
    const S = this.R.SolverFlags;
    const s = this.sword;
    if (!s) return S.COMPUTE_IMPULSE;
    let other;
    if (c1 === s.bladeHandle) other = c2; else if (c2 === s.bladeHandle) other = c1; else return S.COMPUTE_IMPULSE;
    const piece = this.pieces.get(other);
    if (!piece) return S.COMPUTE_IMPULSE;
    if (piece.passUntil > this.time) return S.EMPTY;
    const ev = this._evalCut(piece);
    if (ev && ev.cut) {
      piece.passUntil = this.time + 0.25;
      this.cutQueue.push({ piece, ...ev });
      return S.EMPTY;
    }
    return S.COMPUTE_IMPULSE;
  }

  _evalCut(piece) {
    const s = this.sword;
    // piece centroid in world (pose snapshot taken from the body before the step)
    const pp = piece.snap;
    if (!pp) return null;
    const cLocal = piece.centroid || (piece.centroid = piece.points.reduce((a, p) => a.add(p), V(0, 0, 0)).multiplyScalar(1 / piece.points.length));
    const C = cLocal.clone().applyQuaternion(pp.q).add(pp.p);
    // closest point on the blade segment
    const a = s.grip.clone().addScaledVector(s.axisY, 0.1), b = s.grip.clone().addScaledVector(s.axisY, 1.0);
    const ab = b.clone().sub(a);
    const u = Math.max(0, Math.min(1, C.clone().sub(a).dot(ab) / ab.lengthSq()));
    const P = a.addScaledVector(ab, u);
    const v = s.linvel.clone().add(new THREE.Vector3().crossVectors(s.angvel, P.clone().sub(s.com)));
    const vPerp = v.clone().addScaledVector(s.axisY, -v.dot(s.axisY));
    const speed = vPerp.length();
    const align = speed > 1e-3 ? Math.abs(vPerp.dot(s.axisX)) / speed : 0;
    const pr = this.params;
    const inv = s.involvement ?? 1;
    const mEff = pr.mWrist + (pr.mArm - pr.mWrist) * inv;
    const energy = 0.5 * mEff * speed * speed;
    this.stats.lastAlign = align;
    this.stats.lastSpeed = speed;
    this.stats.lastEnergy = energy;
    this.stats.lastInvolvement = inv;
    const cut = speed > pr.minCutSpeed && align > pr.minAlign && energy >= pr.cutEnergy;
    const nrm = new THREE.Vector3().crossVectors(s.axisY, vPerp).normalize();
    return { cut, point: P, normal: nrm, speed, align, energy, vdir: vPerp.normalize() };
  }

  /** Snapshot piece poses before stepping (hooks can't touch the world during the step). */
  preStep(h = 1 / 240) {
    for (const sp of this.springs) {
      // tilt-only spring (swing part of the rotation): torque about (up × bodyUp). Twist about the
      // post's own axis has tiny inertia and would make an explicit spring unstable, so it's left free.
      const r = sp.body.rotation(), w = sp.body.angvel();
      const ux = 2 * (r.x * r.y - r.w * r.z), uy = 1 - 2 * (r.x * r.x + r.z * r.z), uz = 2 * (r.y * r.z + r.w * r.x); // body up
      const ax = uz, az = -ux; // (0,1,0) × up
      const s = Math.hypot(ax, az);
      const ang = Math.atan2(s, uy);
      let tx = 0, tz = 0;
      if (s > 1e-6) { tx = (-sp.k * ang * ax) / s; tz = (-sp.k * ang * az) / s; }
      // damp angular velocity perpendicular to the body axis
      const wu = w.x * ux + w.y * uy + w.z * uz;
      const px = w.x - wu * ux, py = w.y - wu * uy, pz = w.z - wu * uz;
      sp.body.applyTorqueImpulse({ x: (tx - sp.c * px) * h, y: -sp.c * py * h, z: (tz - sp.c * pz) * h }, true);
    }
    for (const p of this.pieces.values()) {
      const t = p.body.translation(), r = p.body.rotation();
      if (!p.snap) p.snap = { p: V(0, 0, 0), q: new THREE.Quaternion() };
      p.snap.p.set(t.x, t.y, t.z);
      p.snap.q.set(r.x, r.y, r.z, r.w);
    }
  }

  /** Apply queued cuts after the step. Returns list of cut events for FX. */
  postStep(h) {
    this.time += h;
    const events = [];
    const queue = this.cutQueue;
    this.cutQueue = [];
    for (const c of queue) {
      const piece = c.piece;
      if (!this.pieces.has(piece.collider.handle)) continue;
      const q = piece.snap.q, p = piece.snap.p;
      const qi = q.clone().invert();
      const pLocal = c.point.clone().sub(p).applyQuaternion(qi);
      const nLocal = c.normal.clone().applyQuaternion(qi);
      const split = slicePoints(piece.points, pLocal, nLocal);
      if (!split) continue;
      const lv = piece.body.linvel(), av = piece.body.angvel();
      const baseV = V(lv.x, lv.y, lv.z), baseW = V(av.x, av.y, av.z);
      let keepA = false;
      if (piece.attachTo) keepA = nLocal.dot(piece.attachTo.anchorLocal.clone().sub(pLocal)) >= 0;
      this._removePiece(piece);
      const push = c.vdir.clone().multiplyScalar(0.5 + Math.random() * 0.4);
      const spin = c.normal.clone().multiplyScalar((Math.random() - 0.5) * 3);
      const pa = this._spawnPiece(split.a, p, q, {
        attachTo: piece.attachTo && keepA ? piece.attachTo : null, h: piece.h, r: piece.r, tag: piece.tag,
        linvel: keepA && piece.attachTo ? baseV : baseV.clone().add(push), angvel: keepA && piece.attachTo ? baseW : baseW.clone().add(spin),
      });
      const pb = this._spawnPiece(split.b, p, q, {
        attachTo: piece.attachTo && !keepA ? piece.attachTo : null, h: piece.h, r: piece.r, tag: piece.tag,
        linvel: !keepA && piece.attachTo ? baseV : baseV.clone().add(push), angvel: !keepA && piece.attachTo ? baseW : baseW.clone().add(spin),
      });
      for (const np of [pa, pb]) if (np) np.passUntil = this.time + 0.25;
      this.stats.cuts++;
      this.stats.lastCut = { speed: c.speed, align: c.align };
      events.push({ point: c.point, normal: c.normal, speed: c.speed, align: c.align, energy: c.energy, vdir: c.vdir, tag: piece.tag });
    }
    // cap debris
    if (this.pieces.size > MAX_PIECES) {
      const free = [...this.pieces.values()].filter((p) => !p.attachTo).sort((a, b) => a.born - b.born);
      for (let i = 0; i < this.pieces.size - MAX_PIECES && i < free.length; i++) this._removePiece(free[i]);
    }
    return events;
  }

  /** Wood notch decal on the pell. */
  addMark(point, edgeDir) {
    if (!this.pell) return;
    const { body, mesh, marks } = this.pell;
    const t = body.translation(), r = body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const qi = q.clone().invert();
    const lp = point.clone().sub(V(t.x, t.y, t.z)).applyQuaternion(qi);
    const radial = V(lp.x, 0, lp.z);
    if (radial.lengthSq() < 1e-6) return;
    radial.normalize();
    lp.x = radial.x * 0.112; lp.z = radial.z * 0.112;
    const notch = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.06 + Math.random() * 0.04, 0.012),
      new THREE.MeshStandardMaterial({ color: 0x2b1a0e, roughness: 1 }));
    notch.position.copy(lp);
    const d = edgeDir.clone().applyQuaternion(qi);
    notch.lookAt(lp.clone().add(radial));
    notch.rotateZ(Math.atan2(d.y, Math.hypot(d.x, d.z)) + Math.PI / 2);
    mesh.add(notch);
    marks.push(notch);
    if (marks.length > 80) mesh.remove(marks.shift());
  }

  update() {
    for (const s of this.synced) {
      const t = s.body.translation(), r = s.body.rotation();
      s.mesh.position.set(t.x, t.y, t.z);
      s.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
    const ropeTo = (line, a, b) => {
      const p = line.geometry.attributes.position;
      p.setXYZ(0, a.x, a.y, a.z); p.setXYZ(1, b.x, b.y, b.z); p.needsUpdate = true;
    };
    if (this.quintain) {
      const { arm, bag, rope, bagTop } = this.quintain;
      const t = arm.translation(), r = arm.rotation();
      const end = V(0, 0, this.quintain.bagArm).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w)).add(V(t.x, t.y, t.z));
      const bt = bag.translation(), br = bag.rotation();
      const top = V(0, bagTop - 0.05, 0).applyQuaternion(new THREE.Quaternion(br.x, br.y, br.z, br.w)).add(V(bt.x, bt.y, bt.z));
      ropeTo(rope, end, top);
    }
    if (this.heavyBag) {
      const { body, rope, top, half } = this.heavyBag;
      const bt = body.translation(), br = body.rotation();
      const p = V(0, half - 0.7, 0).applyQuaternion(new THREE.Quaternion(br.x, br.y, br.z, br.w)).add(V(bt.x, bt.y, bt.z));
      ropeTo(rope, top, p);
    }
  }
}
