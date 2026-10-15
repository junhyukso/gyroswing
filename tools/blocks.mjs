// Block-drill recording analysis: replay through the controller and list the held guards (quiet
// moments after a move) with blade/edge direction, where the hand model put the hands, and how far
// the accelerometer says the phone really travelled to get there.
//   node tools/blocks.mjs [recording] [--timeline]
import fs from 'node:fs';
import path from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { Controller } from '../public/js/controller.js';

const args = process.argv.slice(2);
const arg = args.find((a) => !a.startsWith('--'));
const file = arg || path.join('recordings', fs.readdirSync('recordings').filter((f) => f.endsWith('.json')).sort().pop());
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const IOS = { perm: [2, 0, 1], sign: [1, 1, 1], scale: Math.PI / 180, confident: true };
const f2 = (v) => `(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})`;

const c = new Controller();
c.fusion.mapping = { ...IOS };
c.fusion.accSign = -1;
if (rec.meta?.calib) c.calib.fromJSON(rec.meta.calib);
const out = { pos: new Vector3(), quat: new Quaternion(), w: new Vector3(), v: new Vector3(), dir: new Vector3() };
const S = rec.samples;
const toBody = (aE) => aE.clone().applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)).applyQuaternion(c.calib.Y);

// raw accelerometer displacement (body frame), leaky-integrated so it forgets after ~1 s
const vel = new Vector3(), disp = new Vector3();
const rows = [];
let i = 0, prevRecv = null;
for (let t = S[0].recv; t < S.at(-1).recv; t += 1000 / 120) {
  while (i < S.length && S[i].recv <= t) {
    const s = S[i++];
    c.push({ ...s });
    if (!c.ready) continue;
    const dt = prevRecv == null ? 1 / 60 : Math.min(0.05, (s.recv - prevRecv) / 1000);
    prevRecv = s.recv;
    const a = toBody(c.fusion.aE);
    vel.addScaledVector(a, dt).multiplyScalar(Math.exp(-dt / 0.6));
    disp.addScaledVector(vel, dt).multiplyScalar(Math.exp(-dt / 1.2));
  }
  if (!c.ready) continue;
  c.target(t, out);
  const edge = new Vector3(1, 0, 0).applyQuaternion(out.quat); // sword local +x = edge
  const base = c.arm.baseGrip(out.dir, new Vector3());
  rows.push({ t: (t - S[0].recv) / 1000, w: c.fusion.w.length(), dir: out.dir.clone(), edge, pos: out.pos.clone(), base, disp: disp.clone(), btn: S[Math.max(0, i - 1)].buttons });
}

if (args.includes('--timeline')) {
  for (let k = 0; k < rows.length; k += 12) {
    const r = rows[k];
    console.log(`${r.t.toFixed(1).padStart(5)} w${r.w.toFixed(1).padStart(5)} dir${f2(r.dir)} edge${f2(r.edge)} hand${f2(r.pos)} acc${f2(r.disp)}${r.btn ? ' btn' + r.btn : ''}`);
  }
}

// guards = quiet holds (|w| < 1.2 for >= 0.25 s) right after a move (|w| > 3)
const holds = [];
let moved = -9, start = null;
for (const r of rows) {
  if (r.w > 3) moved = r.t;
  if (r.w < 1.2) { if (start == null && r.t - moved < 0.6) start = r; }
  else if (start) { const end = r; if (end.t - start.t >= 0.25) holds.push([start, end]); start = null; }
}
console.log(`${path.basename(file)} · ${((S.at(-1).recv - S[0].recv) / 1000).toFixed(1)} s · ${holds.length} holds`);
console.log('  t     dur  blade dir (body)      edge                 hand (model)         accel travel into hold');
for (const [a, b] of holds) {
  const mid = rows.find((r) => r.t >= (a.t + b.t) / 2);
  // travel = accel displacement change over the 0.5 s move into the hold
  const before = rows.find((r) => r.t >= a.t - 0.5) || rows[0];
  const travel = mid.disp.clone().sub(before.disp);
  console.log(`${a.t.toFixed(1).padStart(5)} ${(b.t - a.t).toFixed(2)}  ${f2(mid.dir).padEnd(20)} ${f2(mid.edge).padEnd(20)} ${f2(mid.pos).padEnd(20)} ${f2(travel)}`);
}

// block holds = holds that aren't the resting guard, labelled by the level-1 attack order
const REST_DIR = new Vector3(-0.1, 0.8, -0.58).normalize(), REST_EDGE = new Vector3(-0.45, -0.52, -0.68).normalize();
const LABELS = ['overhead', 'diagR', 'horizL', 'diagL', 'horizR', 'thrust'];
const blocks = [];
for (const [a, b] of holds) {
  const mid = rows.find((r) => r.t >= (a.t + b.t) / 2);
  if (mid.dir.angleTo(REST_DIR) < 0.45 && mid.edge.angleTo(REST_EDGE) < 0.6) continue;
  const wPeak = Math.max(...rows.filter((r) => r.t > a.t - 0.8 && r.t <= a.t).map((r) => r.w));
  blocks.push({ t: +a.t.toFixed(2), dur: +(b.t - a.t).toFixed(2), wPeak: +wPeak.toFixed(1), dir: mid.dir.toArray().map((x) => +x.toFixed(3)), edge: mid.edge.toArray().map((x) => +x.toFixed(3)), hand: mid.pos.toArray().map((x) => +x.toFixed(3)) });
}
// assign attack labels: one attack per ~3.5 s slot
const T0 = blocks[0]?.t ?? 0, CYCLE = 3.52;
for (const b of blocks) b.attack = LABELS[Math.round((b.t - T0) / CYCLE) % 6];
console.log('\nblock holds:');
for (const b of blocks) console.log(`${String(b.t).padStart(5)} ${b.attack.padEnd(8)} wPeak ${String(b.wPeak).padStart(4)}  dir ${JSON.stringify(b.dir)} edge ${JSON.stringify(b.edge)} hand ${JSON.stringify(b.hand)}`);
if (args.includes('--json')) fs.writeFileSync(args[args.indexOf('--json') + 1], JSON.stringify(blocks));
