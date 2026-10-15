// Frame profiler: CPU milliseconds per section of the frame (performance.now) and the GPU time of the
// render (WebGL2 timer queries, where the browser exposes them). On while the debug HUD is open or with
// ?prof; when off every call is a single branch.
export class Perf {
  constructor(renderer) {
    this.on = /[?&]prof/.test(location.search);
    this.cur = {};
    this.sum = {};
    this.frames = 0;
    this.report = null;       // { section: ms/frame, ..., frame, gpu, longFrames, heapMBs }
    this._since = 0;
    this._long = 0;
    this._heap = null;
    this._alloc = 0;
    const gl = renderer.getContext();
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this._queries = [];       // pending GPU queries
    this._gpuSum = 0;
    this._gpuN = 0;
    this._q = null;
    this._frameNo = 0;
    this.gpuMs = null;        // smoothed GPU time of a frame (ms), measured every few frames even when off
  }

  now() { return this.on ? performance.now() : 0; }
  add(key, t0) { if (this.on) this.cur[key] = (this.cur[key] || 0) + performance.now() - t0; }

  gpuBegin() {
    // the auto quality needs GPU time all the time: every 3rd frame when the profiler is off
    if (!this.ext || this._q || (!this.on && this._frameNo++ % 3)) return;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this._q = q;
  }
  gpuEnd() {
    if (!this._q) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this._queries.push(this._q);
    this._q = null;
  }
  _pollGpu() {
    const gl = this.gl;
    while (this._queries.length) {
      const q = this._queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      if (!gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this._gpuSum += ms; this._gpuN++;
        this.gpuMs = this.gpuMs == null ? ms : this.gpuMs + (ms - this.gpuMs) * 0.1;
      }
      gl.deleteQuery(q);
      this._queries.shift();
    }
  }

  /** Call once at the end of a frame with its total CPU time (ms) and the wall-clock dt (s). */
  endFrame(frameMs, dt) {
    if (!this.on) { if (this.report) this.report = null; this._pollGpu(); this._gpuSum = 0; this._gpuN = 0; return; }
    this._lastFrame = { ...this.cur, frame: frameMs }; // for benches
    for (const k in this.cur) { this.sum[k] = (this.sum[k] || 0) + this.cur[k]; this.cur[k] = 0; }
    this.sum.frame = (this.sum.frame || 0) + frameMs;
    this.frames++;
    if (dt > 1 / 40) this._long++;
    const mem = performance.memory;
    if (mem) {
      const h = mem.usedJSHeapSize;
      if (this._heap != null && h > this._heap) this._alloc += h - this._heap; // growth between GCs ≈ allocation
      this._heap = h;
    }
    this._pollGpu();
    this._since += dt;
    if (this._since < 0.5) return;
    const r = {};
    for (const k in this.sum) r[k] = this.sum[k] / this.frames;
    r.gpu = this._gpuN ? this._gpuSum / this._gpuN : null;
    r.longFrames = this._long;
    r.heapMBs = mem ? this._alloc / 1e6 / this._since : null;
    r.fps = this.frames / this._since;
    this.report = r;
    this.sum = {}; this.frames = 0; this._since = 0; this._long = 0; this._alloc = 0; this._gpuSum = 0; this._gpuN = 0;
  }

  /** One-line summary for the HUD. */
  text(labels) {
    const r = this.report;
    if (!r) return '';
    const parts = Object.entries(labels).filter(([k]) => r[k] != null).map(([k, name]) => `${name} ${r[k].toFixed(2)}`);
    return `CPU ${r.frame.toFixed(2)}ms/프레임 (${parts.join(' · ')})  GPU ${r.gpu != null ? r.gpu.toFixed(2) + 'ms' : '?'}  ` +
      `끊김 ${r.longFrames}/0.5s  할당 ${r.heapMBs != null ? r.heapMBs.toFixed(1) + 'MB/s' : '?'}`;
  }
}
