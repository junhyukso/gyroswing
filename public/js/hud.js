// Debug HUD and live tuning panel (lil-gui). Tuned values persist in localStorage.
import GUI from 'three/addons/libs/lil-gui.module.min.js';

const STORE = 'gyrosword.params.v1';

/**
 * migrations: { version: { section: [keys] } } — saved values of these keys are dropped when the saved
 * data is older than that version, so a changed default reaches players who once touched the panel.
 */
export function buildGui(sections, onChange, { version = 1, migrations = {} } = {}) {
  const gui = new GUI({ title: '튜닝 (G)' });
  gui.hide();
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch {}
  const savedV = saved._v || 1;
  for (const [v, secs] of Object.entries(migrations)) {
    if (savedV >= +v) continue;
    for (const [sec, keys] of Object.entries(secs)) for (const k of keys) if (saved[sec]) delete saved[sec][k];
  }
  const save = () => {
    const out = { _v: version };
    for (const [name, obj] of Object.entries(sections)) out[name] = { ...obj.target };
    try { localStorage.setItem(STORE, JSON.stringify(out)); } catch {}
  };
  for (const [name, { target, label, fields }] of Object.entries(sections)) {
    if (saved[name]) for (const k of Object.keys(fields)) if (k in saved[name]) target[k] = saved[name][k];
    const f = gui.addFolder(label);
    for (const [k, spec] of Object.entries(fields)) {
      const c = typeof target[k] === 'boolean' ? f.add(target, k) : f.add(target, k, spec[0], spec[1], spec[2]);
      c.name(spec[3] || k).onChange(() => { save(); onChange?.(name, k); });
    }
    f.close();
  }
  gui.add({ reset: () => { localStorage.removeItem(STORE); location.reload(); } }, 'reset').name('기본값으로 (새로고침)');
  return gui;
}

export class Hud {
  constructor() {
    this.el = document.getElementById('hud');
    this.help = document.getElementById('help');
    this.visible = false;
    this.el.style.display = 'none';
    this._t = 0;
  }
  toggle() {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }
  update(dt, fn) {
    if (!this.visible) return;
    this._t += dt;
    if (this._t < 0.1) return;
    this._t = 0;
    this.el.textContent = fn();
  }
}
