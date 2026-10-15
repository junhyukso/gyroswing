// Render quality. Fixed levels, or 'auto': step down when the GPU can't hold the display's frame rate,
// back up when there's lots of headroom. GPU time comes from timer queries (Perf.gpuMs); browsers
// without them fall back to counting missed frames (down only).
//
// What each level costs was measured (qa/perfbench.js, RTX 5080): the GTAO ambient occlusion pass is
// by far the largest and scales with pixels (4K: ~2.6 of 3.0 ms), then the 4096 shadow map, then bloom.
export const LEVELS = {
  high: { name: '높음', gtao: true, shadow: 4096, bloom: true, maxDpr: 1.5 },
  medium: { name: '중간', gtao: false, shadow: 2048, bloom: true, maxDpr: 1.25 },
  low: { name: '낮음', gtao: false, shadow: 1024, bloom: false, maxDpr: 1.0 },
};
const ORDER = ['low', 'medium', 'high'];

export class Quality {
  constructor({ renderer, env, fitView, mode = 'auto' }) {
    this.renderer = renderer;
    this.env = env;
    this.fitView = fitView;
    this.mode = mode;            // 'auto' | 'high' | 'medium' | 'low'
    this.level = mode === 'auto' ? 'high' : mode;
    this.intervalMs = 1000 / 60; // display frame interval, measured
    this._dts = [];
    this._over = 0;              // seconds the GPU has been over budget
    this._under = 0;             // seconds with lots of headroom
    this._missed = [];
    this._cool = 0;              // no changes for a moment after one (the new level needs to settle)
    this._downAt = -1e9;         // time of the last step down (blocks stepping back up for a while)
    this._failedAt = {};         // level -> when it last couldn't keep up (not retried for 2 min)
    this._t = 0;
    this.apply(this.level);
  }

  setMode(mode) {
    this.mode = mode;
    this._over = this._under = 0;
    this.apply(mode === 'auto' ? 'high' : mode);
  }

  apply(level) {
    const L = LEVELS[level];
    if (!L) return;
    this.level = level;
    const { env, renderer } = this;
    if (env.gtao) env.gtao.enabled = L.gtao;
    env.bloom.enabled = L.bloom;
    const sh = env.sun.shadow;
    if (sh.mapSize.x !== L.shadow) {
      sh.mapSize.set(L.shadow, L.shadow);
      if (sh.map) { sh.map.dispose(); sh.map = null; } // re-created at the new size on the next render
    }
    const pr = Math.min(window.devicePixelRatio || 1, L.maxDpr);
    if (renderer.getPixelRatio() !== pr) {
      renderer.setPixelRatio(pr);
      env.composer.setPixelRatio(pr);
      this.fitView(true);
    }
    this._cool = 1.0;
  }

  /** Budget for the GPU per frame: most of the display interval (the CPU and compositor need the rest). */
  get budgetMs() { return this.intervalMs * 0.75; }

  /** Once per rendered frame. dt: wall time since the last frame (s); gpuMs: smoothed GPU time or null. */
  frame(dt, gpuMs) {
    if (!(dt > 0) || dt > 0.25 || document.hidden) return;
    this._t += dt;
    // display refresh: median frame interval over the last second or so
    this._dts.push(dt * 1000);
    if (this._dts.length > 90) this._dts.shift();
    if (this._dts.length >= 30 && this._dts.length % 15 === 0) {
      const s = [...this._dts].sort((a, b) => a - b);
      this.intervalMs = s[s.length >> 1];
    }
    if (this.mode !== 'auto') return;
    if (this._cool > 0) { this._cool -= dt; return; }
    const i = ORDER.indexOf(this.level);
    if (gpuMs != null) {
      const budget = this.budgetMs;
      this._over = gpuMs > budget ? this._over + dt : 0;
      // the next level up costs up to ~2-3x (GTAO), so only with plenty of room, and not soon after a drop
      const up = ORDER[i + 1];
      const retry = up && this._t - (this._failedAt[up] ?? -1e9) > 120;
      this._under = gpuMs < budget * 0.3 && retry && this._t - this._downAt > 20 ? this._under + dt : 0;
      if (this._over > 1.5 && i > 0) { this._failedAt[this.level] = this._downAt = this._t; this._over = 0; this.apply(ORDER[i - 1]); }
      else if (this._under > 6 && up) { this._under = 0; this.apply(up); }
    } else {
      // no GPU timer: missed frames (a frame taking 1.5x the display interval) over the last 2 s
      this._missed.push(dt * 1000 > this.intervalMs * 1.5 ? 1 : 0);
      if (this._missed.length > 120) this._missed.shift();
      const rate = this._missed.reduce((a, b) => a + b, 0) / this._missed.length;
      if (this._missed.length >= 120 && rate > 0.15 && i > 0) { this._missed = []; this._failedAt[this.level] = this._downAt = this._t; this.apply(ORDER[i - 1]); }
    }
  }

  text(gpuMs) {
    const hz = 1000 / this.intervalMs;
    return `화질 ${LEVELS[this.level].name}${this.mode === 'auto' ? ' (자동)' : ''}  GPU ${gpuMs != null ? gpuMs.toFixed(2) + 'ms' : '?'} / 예산 ${this.budgetMs.toFixed(1)}ms  화면 ${hz.toFixed(0)}Hz`;
  }
}
