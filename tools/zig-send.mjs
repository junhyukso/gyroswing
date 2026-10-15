// Re-send the ZIG SIM messages of a recording to a server's ZIG UDP port at their original timing (as
// JSON) — end-to-end tests of the game's ZIG mode without the phone. Use a test server on its own port.
//   node tools/zig-send.mjs <recording> [port=50001] [speed=1]
import fs from 'node:fs';
import dgram from 'node:dgram';

const [file, port = '50001', speed = '1'] = process.argv.slice(2);
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const Z = rec.events.filter((e) => e.type === 'zig').sort((a, b) => a.recv - b.recv);
const sock = dgram.createSocket('udp4');
const t0 = Z[0].recv, start = performance.now();
let i = 0;
function pump() {
  const el = (performance.now() - start) * Number(speed);
  while (i < Z.length && Z[i].recv - t0 <= el) sock.send(JSON.stringify(Z[i++].d), Number(port), '127.0.0.1');
  if (i < Z.length) setTimeout(pump, 2);
  else { console.log(`sent ${Z.length} messages`); setTimeout(() => sock.close(), 100); }
}
pump();
