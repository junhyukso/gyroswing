// Produce a recording in the same format as the game's F9 recorder, from the simulated phone.
// Used to test tools/analyze.mjs without a phone.   node tools/simrec.mjs out.json
import fs from 'node:fs';
import { SimPhone } from '../public/js/sim.js';

let now = 1000;
const samples = [];
const sim = new SimPhone((s) => samples.push(s));
sim.clock = () => now;
sim.setEnabled(true);
const run = (ms) => { for (let t = 0; t < ms; t += 4) { now += 4; sim.update(now); } };
run(1000);
for (const name of ['horizontal', 'diagonal', 'vertical', 'rising', 'thrust', 'horizontal', 'vertical']) {
  sim.swing(name);
  run(1800);
}
samples.forEach((s, i) => { s.seq = i & 0xffff; });
const out = process.argv[2] || 'sim-recording.json';
fs.writeFileSync(out, JSON.stringify({ version: 1, started: new Date().toISOString(), meta: { sim: true }, samples, events: [] }));
console.log(`wrote ${samples.length} samples to ${out}`);
