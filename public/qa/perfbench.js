// Performance bench (dev only). In a `?manual&prof` page:
//   const P = await import('/qa/perfbench.js'); await P.setup(); await P.cpu('block', 300); P.gpu(60)
// cpu(): frames stepped one by one (each rendered); section times from game.perf (CPU ms per frame).
// gpu(): render-only, with gl.finish() so the GPU work is inside the measured time; per pass config.
const g = window.game;

export async function setup() {
  g.advance(17);
  document.getElementById('btnSim').click();
  for (let i = 0; i < 600 && g.flow.active; i++) g.advance(50);
}

const SCENES = {
  idle: () => { g.goStation(0); },
  swing: () => { g.goStation(0); },
  block: () => { g.goStation(5); g.blockDrill.setLevel(1); },
  drills: () => { g.goStation(4); },
};
const SWINGS = ['diagonal', 'horizontal', 'vertical', 'rising'];

/** CPU cost per frame in a scene: returns averaged sections (ms) + wall ms/frame. */
export async function cpu(scene = 'idle', frames = 300) {
  SCENES[scene]();
  g.advance(1500);
  const sum = {}, wall = [];
  let n = 0;
  for (let i = 0; i < frames; i++) {
    if (scene === 'swing' && i % 50 === 0) g.sim.swing(SWINGS[(i / 50) % SWINGS.length]);
    if (scene === 'swing' && i % 300 === 299) g.targets.resetAll?.();
    const t0 = performance.now();
    g.advance(1000 / 60);
    wall.push(performance.now() - t0);
    const cur = g.perf._lastFrame;
    if (cur) { for (const k in cur) sum[k] = (sum[k] || 0) + cur[k]; n++; }
    if (i % 30 === 29) await new Promise((r) => setTimeout(r, 0)); // let the GC / GPU queries breathe
  }
  const out = {};
  for (const k in sum) out[k] = +(sum[k] / n).toFixed(3);
  wall.sort((a, b) => a - b);
  out.wallMed = +wall[wall.length >> 1].toFixed(2);
  out.wallP95 = +wall[Math.floor(wall.length * 0.95)].toFixed(2);
  out.wallMax = +wall.at(-1).toFixed(2);
  out.pieces = g.targets.pieces?.size;
  out.bodies = g.world.bodies.len();
  return out;
}

/** GPU+CPU render cost (ms/frame, gl.finish) for pass configurations. */
export function gpu(frames = 60) {
  const env = g.env, gl = g.renderer.getContext();
  const passes = env.composer.passes;
  const conf = {
    all: () => passes.forEach((p) => (p.enabled = true)),
    noGTAO: () => { if (env.gtao) env.gtao.enabled = false; },
    noBloom: () => { env.bloom.enabled = false; },
    noSMAA: () => { passes.at(-1).enabled = false; },
    noShadow: () => { g.renderer.shadowMap.autoUpdate = false; },
  };
  const time = () => {
    gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) { env.composer.render(1 / 60); gl.finish(); }
    return +((performance.now() - t0) / frames).toFixed(2);
  };
  const out = { buffer: g.renderer.getDrawingBufferSize(new g.THREE.Vector2()).toArray() };
  for (const [name, f] of Object.entries(conf)) {
    passes.forEach((p) => (p.enabled = true)); g.renderer.shadowMap.autoUpdate = true;
    f();
    out[name] = time();
  }
  passes.forEach((p) => (p.enabled = true)); g.renderer.shadowMap.autoUpdate = true;
  // draw calls of one full frame
  g.renderer.info.autoReset = false; g.renderer.info.reset();
  env.composer.render(1 / 60);
  out.calls = g.renderer.info.render.calls; out.triangles = g.renderer.info.render.triangles;
  g.renderer.info.autoReset = true;
  return out;
}

/** GPU+CPU render cost per quality level at a buffer size (warm-up first: GPU clocks ramp). */
export async function levels(w = null, h = null, frames = 120) {
  const env = g.env, r = g.renderer, gl = r.getContext(), q = g.qual, out = {};
  const size = () => { if (w) { r.setPixelRatio(1); env.composer.setPixelRatio(1); r.setSize(w, h, false); env.resize(w, h); } };
  const run = (n) => { for (let i = 0; i < n; i++) { env.composer.render(1 / 60); gl.finish(); } };
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  // GPU-side time (timer query over all frames), median of 3 rounds per level, levels interleaved
  const res = { high: [], medium: [], low: [] };
  for (let round = 0; round < 3; round++) {
    for (const lv of ['high', 'medium', 'low']) {
      q.apply(lv); size();
      run(30);
      const qy = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, qy);
      for (let i = 0; i < frames; i++) env.composer.render(1 / 60);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      gl.finish();
      let ns = null; // results only arrive after yielding to the browser
      for (let k = 0; k < 200 && ns == null; k++) {
        await new Promise((r2) => setTimeout(r2, 5));
        if (gl.getQueryParameter(qy, gl.QUERY_RESULT_AVAILABLE)) ns = gl.getQueryParameter(qy, gl.QUERY_RESULT);
      }
      gl.deleteQuery(qy);
      res[lv].push(ns != null ? ns / 1e6 / frames : NaN);
    }
  }
  for (const lv in res) out[lv] = +res[lv].sort((a, b) => a - b)[1].toFixed(2);
  out.buffer = r.getDrawingBufferSize(new g.THREE.Vector2()).toArray();
  q.apply(q.mode === 'auto' ? 'high' : q.mode); g.renderer.setSize(innerWidth, innerHeight, false); env.resize(innerWidth, innerHeight);
  return out;
}

/** JS heap allocated per simulated second in a scene (sum of heap growth between GCs, frame by frame). */
export async function alloc(scene = 'block', seconds = 10) {
  SCENES[scene]();
  g.advance(1500);
  // performance.memory only refreshes now and then: sample it between batches of 20 frames, after a pause
  const mem = performance.memory;
  const pause = () => new Promise((r) => setTimeout(r, 120));
  await pause();
  let prev = mem.usedJSHeapSize, grown = 0, gcs = 0;
  for (let i = 0; i < seconds * 60; i++) {
    if (scene === 'swing' && i % 50 === 0) g.sim.swing(SWINGS[(i / 50) % SWINGS.length]);
    g.advance(1000 / 60);
    if (i % 20 === 19) {
      await pause();
      const h = mem.usedJSHeapSize;
      if (h >= prev) grown += h - prev; else gcs++;
      prev = h;
    }
  }
  return { scene, MBperSec: +(grown / 1e6 / seconds).toFixed(2), gcs };
}
