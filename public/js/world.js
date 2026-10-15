// Training yard: sky, light, ground, palisade, props, post-processing, static colliders.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';

export const ARENA_R = 11;
export const GROUPS = {
  // Rapier interaction groups: (membership << 16) | filter
  STATIC: 1 << 0, SWORD: 1 << 1, PLAYER: 1 << 2, TARGET: 1 << 3, DEBRIS: 1 << 4, ENEMY: 1 << 5,
};
export function groups(member, filter) { return ((member & 0xffff) << 16) | (filter & 0xffff); }

function rand(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function noiseSpeckle(g, w, h, n, colors, size = [1, 3], alpha = 0.35, rnd = Math.random) {
  for (let i = 0; i < n; i++) {
    const c = colors[(rnd() * colors.length) | 0];
    g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha * (0.4 + rnd() * 0.6)})`;
    const s = size[0] + rnd() * (size[1] - size[0]);
    g.fillRect(rnd() * w, rnd() * h, s, s);
  }
}

export function woodTexture(base = [120, 86, 52], seed = 7) {
  const r = rand(seed);
  return canvasTex(256, 512, (g, w, h) => {
    g.fillStyle = `rgb(${base})`;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) {
      const x = r() * w, d = 0.6 + r() * 0.6;
      g.strokeStyle = `rgba(${base[0] * d * 0.6 | 0},${base[1] * d * 0.6 | 0},${base[2] * d * 0.6 | 0},${0.15 + r() * 0.3})`;
      g.lineWidth = 0.5 + r() * 2;
      g.beginPath();
      g.moveTo(x, 0);
      for (let y = 0; y <= h; y += 32) g.lineTo(x + Math.sin(y * 0.02 + i) * 3 * r(), y);
      g.stroke();
    }
    noiseSpeckle(g, w, h, 1500, [[40, 25, 12], [180, 140, 90]], [1, 2], 0.2, r);
  });
}

function buildGround(scene) {
  const SIZE = 64;
  const r = rand(11);
  const tex = canvasTex(2048, 2048, (g, w, h) => {
    // grass base
    g.fillStyle = '#4c5a2c';
    g.fillRect(0, 0, w, h);
    noiseSpeckle(g, w, h, 60000, [[70, 92, 40], [96, 110, 52], [52, 64, 30], [110, 112, 60]], [2, 6], 0.35, r);
    // sand arena with a soft trampled edge
    const cx = w / 2, cy = h / 2, R = (ARENA_R / SIZE) * w;
    const grad = g.createRadialGradient(cx, cy, R * 0.86, cx, cy, R * 1.12);
    grad.addColorStop(0, 'rgba(176,150,108,1)');
    grad.addColorStop(0.55, 'rgba(150,128,88,0.85)');
    grad.addColorStop(1, 'rgba(150,128,88,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(cx, cy, R * 1.12, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgb(176,150,108)';
    g.beginPath(); g.arc(cx, cy, R * 0.86, 0, Math.PI * 2); g.fill();
    g.save();
    g.beginPath(); g.arc(cx, cy, R * 1.05, 0, Math.PI * 2); g.clip();
    noiseSpeckle(g, w, h, 90000, [[196, 172, 128], [150, 124, 86], [120, 98, 70], [210, 190, 150]], [1, 4], 0.3, r);
    // footprints / scuffs
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(110,88,60,${0.06 + r() * 0.08})`;
      g.beginPath();
      g.ellipse(cx + (r() - 0.5) * R * 1.6, cy + (r() - 0.5) * R * 1.6, 6 + r() * 18, 3 + r() * 8, r() * 3, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  });
  const detail = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#808080'; g.fillRect(0, 0, w, h);
    noiseSpeckle(g, w, h, 30000, [[40, 40, 40], [200, 200, 200]], [1, 3], 0.5, r);
  }, false);
  detail.repeat.set(SIZE / 2, SIZE / 2);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, bumpMap: detail, bumpScale: 0.6 });
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const ground = new THREE.Mesh(geo, mat);
  ground.receiveShadow = true;
  scene.add(ground);

  // far grass beyond the textured patch
  const farTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#4c5a2c'; g.fillRect(0, 0, w, h);
    noiseSpeckle(g, w, h, 6000, [[70, 92, 40], [96, 110, 52], [52, 64, 30]], [2, 5], 0.35, r);
  });
  farTex.repeat.set(60, 60);
  const far = new THREE.Mesh(new THREE.RingGeometry(SIZE * 0.5, 600, 64, 1).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ map: farTex, roughness: 1 }));
  far.position.y = -0.01;
  far.receiveShadow = true;
  scene.add(far);
}

function buildPalisade(scene, RAPIER, world) {
  const r = rand(23);
  const R = ARENA_R + 0.6;
  const logR = 0.15;
  const gapA = Math.PI / 2, gapW = 0.22; // entrance behind the player (+z)
  const angles = [];
  for (let a = 0; a < Math.PI * 2; a += (logR * 2.02) / R) {
    let d = Math.abs(((a - gapA + Math.PI) % (Math.PI * 2)) - Math.PI);
    if (d < gapW) continue;
    angles.push(a);
  }
  const wood = woodTexture([112, 82, 52], 31);
  wood.repeat.set(1, 2);
  const mat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.9 });
  const logGeo = new THREE.CylinderGeometry(logR, logR * 1.05, 1, 9, 1);
  const tipGeo = new THREE.ConeGeometry(logR, 0.38, 9, 1);
  const logs = new THREE.InstancedMesh(logGeo, mat, angles.length);
  const tips = new THREE.InstancedMesh(tipGeo, mat, angles.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  angles.forEach((a, i) => {
    const h = 2.3 + r() * 0.5;
    const tilt = (r() - 0.5) * 0.05;
    q.setFromEuler(new THREE.Euler(tilt, r() * 6, (r() - 0.5) * 0.05));
    p.set(Math.cos(a) * R, h / 2, Math.sin(a) * R);
    s.set(1, h, 1);
    logs.setMatrixAt(i, m.compose(p, q, s));
    p.y = h + 0.19;
    tips.setMatrixAt(i, m.compose(p, q, new THREE.Vector3(1, 1, 1)));
  });
  for (const im of [logs, tips]) { im.castShadow = true; im.receiveShadow = true; scene.add(im); }
  // colliders: thin wall segments
  const segs = 48;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const half = (Math.PI * R) / segs;
    const cd = RAPIER.ColliderDesc.cuboid(half, 1.5, 0.15)
      .setTranslation(Math.cos(a) * R, 1.5, Math.sin(a) * R)
      .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a + Math.PI / 2))
      .setCollisionGroups(groups(GROUPS.STATIC, 0xffff));
    world.createCollider(cd, body);
  }
}

function buildScenery(scene) {
  const r = rand(5);
  // pines outside the palisade
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f4426, roughness: 0.95 });
  const n = 140;
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.2, 1, 6), trunkMat, n);
  const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 7), leafMat, n * 3);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, d = 17 + r() * 55;
    const h = 6 + r() * 9;
    p.set(Math.cos(a) * d, h * 0.2, Math.sin(a) * d);
    trunk.setMatrixAt(i, m.compose(p, q, s.set(1, h * 0.4, 1)));
    for (let k = 0; k < 3; k++) {
      const ch = h * (0.55 - k * 0.12), cw = h * (0.24 - k * 0.05);
      p.set(Math.cos(a) * d, h * (0.38 + k * 0.2) + ch / 2 - h * 0.05, Math.sin(a) * d);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * 6);
      crown.setMatrixAt(i * 3 + k, m.compose(p, q, s.set(cw, ch, cw)));
    }
  }
  q.identity();
  for (const im of [trunk, crown]) { im.castShadow = true; scene.add(im); }

  // distant hills
  const hillGeo = new THREE.CylinderGeometry(260, 260, 1, 96, 1, true);
  const pos = hillGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) {
      const a = Math.atan2(pos.getZ(i), pos.getX(i));
      pos.setY(i, 18 + Math.sin(a * 3) * 9 + Math.sin(a * 7 + 1) * 6 + Math.sin(a * 13 + 2) * 3);
    } else pos.setY(i, -2);
  }
  hillGeo.computeVertexNormals();
  const hills = new THREE.Mesh(hillGeo, new THREE.MeshStandardMaterial({ color: 0x3e4f37, roughness: 1, side: THREE.BackSide }));
  scene.add(hills);

  // banners on poles at the entrance
  const crest = canvasTex(256, 512, (g, w, h) => {
    g.fillStyle = '#7a1c1c'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#d9a441';
    g.fillRect(0, 0, w, 18); g.fillRect(0, h - 60, w, 10);
    g.beginPath(); g.moveTo(w / 2, 120); g.lineTo(w / 2 + 50, 200); g.lineTo(w / 2, 330); g.lineTo(w / 2 - 50, 200); g.closePath(); g.fill();
    g.fillRect(w / 2 - 6, 90, 12, 290);
    g.fillRect(w / 2 - 50, 150, 100, 12);
  });
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1c, roughness: 0.8 });
  for (const sx of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 4.2, 8), poleMat);
    pole.position.set(sx * 2.2, 2.1, ARENA_R - 0.4);
    pole.castShadow = true;
    scene.add(pole);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.8, 6, 12), new THREE.MeshStandardMaterial({ map: crest, side: THREE.DoubleSide, roughness: 0.9 }));
    cloth.position.set(sx * 2.2, 3.0, ARENA_R - 0.45);
    cloth.rotation.y = Math.PI;
    cloth.castShadow = true;
    cloth.userData.wave = true;
    scene.add(cloth);
  }
}

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

export function buildWorld({ renderer, scene, camera, RAPIER, world, quality = 'high' }) {
  // ---- sky + environment lighting
  const sky = new Sky();
  sky.scale.setScalar(4500);
  const su = sky.material.uniforms;
  su.turbidity.value = 2.6;
  su.rayleigh.value = 1.1;
  su.mieCoefficient.value = 0.006;
  su.mieDirectionalG.value = 0.82;
  if (su.cloudCoverage) { su.cloudCoverage.value = 0.35; su.cloudDensity.value = 0.45; }
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(28));
  su.sunPosition.value.copy(sunDir);
  scene.add(sky);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const sky2 = new Sky();
  sky2.scale.setScalar(4500);
  for (const k of Object.keys(su)) if (sky2.material.uniforms[k]) sky2.material.uniforms[k].value = su[k].value;
  envScene.add(sky2);
  // a warm ground bounce in the env map so metal reflects "earth" below the horizon
  const envGround = new THREE.Mesh(new THREE.SphereGeometry(100, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x6b5a40, side: THREE.BackSide }));
  envScene.add(envGround);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.75;
  scene.fog = new THREE.Fog(0xb9c3c9, 40, 320);

  const sun = new THREE.DirectionalLight(0xffe2b8, 3.2);
  sun.position.copy(sunDir).multiplyScalar(30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); // set per quality level (quality.js)
  const sc = sun.shadow.camera;
  sc.left = -16; sc.right = 16; sc.top = 16; sc.bottom = -16; sc.near = 1; sc.far = 80;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x5a4a32, 0.55));

  buildGround(scene);
  buildPalisade(scene, RAPIER, world);
  buildScenery(scene);

  // ground collider
  const gb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.cuboid(60, 0.5, 60).setTranslation(0, -0.5, 0).setFriction(0.9)
    .setCollisionGroups(groups(GROUPS.STATIC, 0xffff)), gb);

  const { composer, bloom, gtao } = makeComposer(renderer, scene, camera);

  const waving = [];
  scene.traverse((o) => { if (o.userData.wave) waving.push(o); });

  return {
    sun, composer, bloom, gtao,
    resize(w, h) { composer.setSize(w, h); },
    update(t) {
      if (su.time) su.time.value = t;
      for (const o of waving) {
        const p = o.geometry.attributes.position;
        if (!o.userData.base) o.userData.base = Float32Array.from(p.array);
        const b = o.userData.base;
        for (let i = 0; i < p.count; i++) {
          const y = b[i * 3 + 1], x = b[i * 3];
          const k = (0.9 - y) / 1.8;
          p.array[i * 3 + 2] = b[i * 3 + 2] + Math.sin(t * 2.2 + y * 3 + x * 2) * 0.05 * (1 + k);
        }
        p.needsUpdate = true;
        o.geometry.computeVertexNormals();
      }
    },
  };
}

/** Post-processing chain for one camera (a second view — split screen — gets its own). */
export function makeComposer(renderer, scene, camera) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  let gtao = null;
  {
    gtao = new GTAOPass(scene, camera, size.x, size.y);
    gtao.blendIntensity = 0.8;
    gtao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 1, scale: 1 });
    // GTAO renders every visible mesh into its depth/normal buffer; transparent effects
    // (swing trail, ghost sword, fading arms) must not occlude, so hide objects tagged noAO.
    const ov = gtao._overrideVisibility.bind(gtao), rv = gtao._restoreVisibility.bind(gtao);
    const hidden = [];
    gtao._overrideVisibility = () => {
      ov();
      scene.traverse((o) => { if (o.visible && (o.userData.noAO || o.material?.transparent)) { o.visible = false; hidden.push(o); } });
    };
    gtao._restoreVisibility = () => { rv(); for (const o of hidden) o.visible = true; hidden.length = 0; };
    // AO at half resolution: the AO and denoise shaders only use `resolution` for texel offsets and noise
    // tiling, so they run on 1/4 of the pixels against the full-res depth/normals and the blend upsamples
    // (linear). GTAO was ~80% of the GPU frame at 4K (qa/perfbench.js).
    const fullSetSize = gtao.setSize.bind(gtao);
    gtao.aoScale = 0.5;
    gtao.setSize = (w, h) => {
      fullSetSize(w, h);
      const aw = Math.max(1, Math.round(w * gtao.aoScale)), ah = Math.max(1, Math.round(h * gtao.aoScale));
      gtao.gtaoRenderTarget.setSize(aw, ah);
      gtao.pdRenderTarget.setSize(aw, ah);
      gtao.gtaoMaterial.uniforms.resolution.value.set(aw, ah);
      gtao.pdMaterial.uniforms.resolution.value.set(aw, ah);
    };
    gtao.setSize(size.x, size.y);
    composer.addPass(gtao);
  }
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.14, 0.3, 3.5);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const smaa = new SMAAPass();
  composer.addPass(smaa);
  return { composer, bloom, gtao };
}
