// Judder check (dev only): render frames at a display rate (e.g. 144 Hz) during simulated swings and
// measure how evenly the DRAWN sword tip moves per frame. In a smooth display the per-frame motion
// changes gradually; a fixed 240 Hz physics step shown without interpolation alternates 1–2 steps per
// frame, which shows up as frame-to-frame jumps in tip speed.
//   const J = await import('/qa/judder.js'); await J.setup(); J.measure(144)
const g = window.game, T = g.THREE;

export async function setup() {
  g.advance(17);
  document.getElementById('btnSim').click();
  for (let i = 0; i < 600 && g.flow.active; i++) g.advance(50);
  g.goStation(4);
  g.advance(1500);
}

export function measure(hz = 144, swings = 6) {
  const step = 1000 / hz;
  const tipOf = () => new T.Vector3(0, 0.9, 0).applyQuaternion(g.swordMeshQuat()).add(g.swordMeshPos());
  const kinds = ['diagonal', 'horizontal', 'vertical'];
  let jerkSum = 0, speedSum = 0, n = 0;
  for (let s = 0; s < swings; s++) {
    g.sim.swing(kinds[s % 3]);
    let prev = tipOf(), prevV = null;
    for (let f = 0; f < Math.round(hz * 0.7); f++) {
      g.advance(step, step);
      const p = tipOf();
      const v = p.distanceTo(prev) / (step / 1000); // drawn tip speed this frame (m/s)
      if (prevV != null && v > 2) { jerkSum += Math.abs(v - prevV); speedSum += v; n++; }
      prevV = v; prev = p;
    }
  }
  // mean frame-to-frame change of drawn tip speed, relative to the speed (smooth -> small)
  return { hz, frames: n, unevenPct: +((100 * jerkSum) / speedSum).toFixed(1) };
}
