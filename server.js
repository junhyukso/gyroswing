// GyroSword dev server
//  - http://localhost:8080        : game (PC browser; localhost is a secure context)
//  - https://<LAN-IP>:8443/phone  : iPhone controller (DeviceMotion needs HTTPS)
//  - /ws                          : WebSocket relay phone <-> game (both ports)
//  - POST /up                     : HTTP uplink fallback for phones whose WSS fails
//  - POST /rec                    : save a sensor recording (localhost only)
//  - UDP :50000                   : ZIG SIM Pro (iOS app) JSON datagrams -> relayed to game pages
//  - /duel                        : local multiplayer (seats: /phone?seat=<id>; a second PC: /duel?join=<room>)
import http from 'node:http';
import dgram from 'node:dgram';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import forge from 'node-forge';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const HTTP_PORT = Number(arg('--http') || process.env.HTTP_PORT || 8080);
const HTTPS_PORT = Number(arg('--https') || process.env.HTTPS_PORT || 8443);
const ZIG_PORT = Number(arg('--zig') || process.env.ZIG_PORT || 50000);
const CERT_DIR = path.join(ROOT, 'certs');
const REC_DIR = path.join(ROOT, 'recordings');

// ---------------------------------------------------------------- network info
function lanIPs() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      if (/vethernet|virtual|vmware|vbox|hyper-v|wsl|loopback/i.test(name)) continue;
      out.push({ name, address: a.address });
    }
  }
  // Wi-Fi / Ethernet first
  out.sort((a, b) => (/wi-?fi|wlan|ethernet|이더넷/i.test(b.name) ? 1 : 0) - (/wi-?fi|wlan|ethernet|이더넷/i.test(a.name) ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------- certificates
// A local root CA (persisted) signs a server cert whose SAN covers every LAN IP.
// iOS: either accept the warning once, or install /ca.crt as a profile and trust it.
function ensureCerts(ips) {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const caKeyP = path.join(CERT_DIR, 'rootCA.key');
  const caCrtP = path.join(CERT_DIR, 'rootCA.crt');
  const keyP = path.join(CERT_DIR, 'server.key');
  const crtP = path.join(CERT_DIR, 'server.crt');
  const metaP = path.join(CERT_DIR, 'server.json');
  const pki = forge.pki;

  let caKey, caCert;
  if (fs.existsSync(caKeyP) && fs.existsSync(caCrtP)) {
    caKey = pki.privateKeyFromPem(fs.readFileSync(caKeyP, 'utf8'));
    caCert = pki.certificateFromPem(fs.readFileSync(caCrtP, 'utf8'));
  } else {
    console.log('[cert] generating local root CA ...');
    const keys = pki.rsa.generateKeyPair(2048);
    caKey = keys.privateKey;
    caCert = pki.createCertificate();
    caCert.publicKey = keys.publicKey;
    caCert.serialNumber = '01' + forge.util.bytesToHex(forge.random.getBytesSync(8));
    caCert.validity.notBefore = new Date(Date.now() - 86400e3);
    caCert.validity.notAfter = new Date(Date.now() + 3650 * 86400e3);
    const attrs = [{ name: 'commonName', value: 'GyroSword Local Dev CA' }, { name: 'organizationName', value: 'GyroSword' }];
    caCert.setSubject(attrs);
    caCert.setIssuer(attrs);
    caCert.setExtensions([
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
    ]);
    caCert.sign(caKey, forge.md.sha256.create());
    fs.writeFileSync(caKeyP, pki.privateKeyToPem(caKey));
    fs.writeFileSync(caCrtP, pki.certificateToPem(caCert));
  }

  const host = os.hostname();
  const wantSAN = ['localhost', host, `${host}.local`, '127.0.0.1', ...ips].join(',');
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaP, 'utf8')); } catch {}
  const fresh = meta && meta.san === wantSAN && meta.notAfter > Date.now() + 7 * 86400e3 && fs.existsSync(keyP) && fs.existsSync(crtP);
  if (!fresh) {
    console.log('[cert] issuing server certificate for', wantSAN);
    const keys = pki.rsa.generateKeyPair(2048);
    const cert = pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '02' + forge.util.bytesToHex(forge.random.getBytesSync(8));
    cert.validity.notBefore = new Date(Date.now() - 86400e3);
    cert.validity.notAfter = new Date(Date.now() + 397 * 86400e3); // Apple: <= 398 days
    cert.setSubject([{ name: 'commonName', value: ips[0] || 'localhost' }, { name: 'organizationName', value: 'GyroSword' }]);
    cert.setIssuer(caCert.subject.attributes);
    const altNames = [
      { type: 2, value: 'localhost' }, { type: 2, value: host }, { type: 2, value: `${host}.local` },
      { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip })),
    ];
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
      { name: 'subjectKeyIdentifier' },
      { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
    ]);
    cert.sign(caKey, forge.md.sha256.create());
    fs.writeFileSync(keyP, pki.privateKeyToPem(keys.privateKey));
    fs.writeFileSync(crtP, pki.certificateToPem(cert) + pki.certificateToPem(caCert));
    fs.writeFileSync(metaP, JSON.stringify({ san: wantSAN, notAfter: cert.validity.notAfter.getTime() }));
  }
  return { key: fs.readFileSync(keyP), cert: fs.readFileSync(crtP), caPem: fs.readFileSync(caCrtP) };
}

// ---------------------------------------------------------------- static files
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.map': 'application/json',
};
const MOUNTS = [
  ['/vendor/three/', path.join(ROOT, 'node_modules/three/')],
  ['/vendor/rapier/', path.join(ROOT, 'node_modules/@dimforge/rapier3d-compat/dist/')],
  ['/', path.join(ROOT, 'public/')],
];
function resolveStatic(urlPath) {
  for (const [prefix, dir] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    const rel = decodeURIComponent(urlPath.slice(prefix.length)) || 'index.html';
    const full = path.resolve(dir, rel);
    if (!full.startsWith(path.resolve(dir))) return null; // traversal
    return full;
  }
  return null;
}
function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

// ---------------------------------------------------------------- relay state
// Seats (local multiplayer): a game page's link can sit in a seat (?seat=<id>); the phone opened from
// that seat's QR (/phone?seat=<id>) is relayed only to it, and its prompts/haptics only to that phone.
// Pages and phones without a seat keep the single-player behaviour among themselves.
const SEAT_RE = /^[a-z0-9]{4,16}$/;
const seatParam = (v) => (SEAT_RE.test(v || '') ? v : null);
const games = new Set();   // ws (ws.seat)
const phones = new Set();  // ws (ws.seat)
const httpPhones = new Map(); // id -> {last, queue:[], seat}
let phoneSeq = 0;

function phoneCount(seat = null) {
  const now = Date.now();
  for (const [id, p] of httpPhones) if (now - p.last > 3000) httpPhones.delete(id);
  let n = 0;
  for (const p of phones) if (p.seat === seat) n++;
  for (const p of httpPhones.values()) if (p.seat === seat) n++;
  return n;
}
function toGames(data, isBinary, seat = null) { for (const g of games) if (g.seat === seat && g.readyState === 1) g.send(data, { binary: isBinary }); }
function toPhones(text, seat = null) {
  for (const p of phones) if (p.seat === seat && p.readyState === 1) p.send(text);
  for (const p of httpPhones.values()) if (p.seat === seat) { p.queue.push(text); if (p.queue.length > 64) p.queue.shift(); }
}
const seatLive = (seat) => [...games].some((g) => g.seat === seat && g.readyState === 1);
function announce() { for (const g of games) if (g.readyState === 1) g.send(JSON.stringify({ type: 'phones', count: phoneCount(g.seat) })); }

// ---------------------------------------------------------------- WebRTC signalling
// The phone (offerer) posts its offer over HTTPS fetch (works even when Safari refuses WSS with our
// certificate); the game answers over its WebSocket. Browsers hide host addresses behind random
// "<uuid>.local" names; resolving those needs mDNS, which firewalls often block. We know both real
// IPs here (the phone's from its request, the PC's from its interfaces), so we write them in.
const rtcSessions = new Map(); // id -> { phoneIp, answer, t }
const plainIp = (a) => String(a || '').replace(/^::ffff:/, '');
function pcIpFor(phoneIp) {
  const net = phoneIp.split('.').slice(0, 3).join('.');
  return INFO.ips.find((ip) => ip.startsWith(net + '.')) || INFO.ips[0] || '127.0.0.1';
}
function unmaskCandidates(sdp, ip) {
  return sdp.replace(/^(a=candidate:\S+ \d+ \S+ \d+ )([0-9a-f-]+\.local)( )/gim, `$1${ip}$3`);
}
function rtcAnswer(m) {
  const s = rtcSessions.get(m.id);
  if (!s || s.answer || typeof m.sdp !== 'string') return;
  if (s.for && m.from !== s.for) return; // offer meant for one game page (it asked the phone for it)
  s.answer = unmaskCandidates(m.sdp, s.phoneIp === '127.0.0.1' ? '127.0.0.1' : pcIpFor(s.phoneIp));
  console.log(`[rtc] answer for ${m.id}${m.from ? ` from game ${m.from}` : ''}`);
}

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 << 20 });
wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const role = q.get('role');
  ws.seat = seatParam(q.get('seat'));
  try { req.socket.setNoDelay(true); } catch {}
  if (role === 'duel') { duelConnect(ws, q); return; }
  if (role === 'game') {
    games.add(ws);
    ws.send(JSON.stringify({ type: 'phones', count: phoneCount(ws.seat) }));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (text.startsWith('{"type":"rtc-answer"')) { try { rtcAnswer(JSON.parse(text)); } catch {} return; }
      if (text.startsWith('{"type":"zig-')) { try { zigControl(ws, JSON.parse(text)); } catch {} return; }
      toPhones(text, ws.seat);
    });
    ws.on('close', () => games.delete(ws));
  } else {
    phones.add(ws);
    const id = ++phoneSeq;
    console.log(`[ws] phone #${id} connected from ${req.socket.remoteAddress}${ws.seat ? ` (seat ${ws.seat})` : ''}`);
    announce();
    ws.on('message', (data, isBinary) => toGames(data, isBinary, ws.seat));
    ws.on('close', () => { phones.delete(ws); console.log(`[ws] phone #${id} disconnected`); announce(); });
  }
});

// ---------------------------------------------------------------- duel rooms (two PCs)
// The host page simulates the fight; a guest page on another PC sends its player's sword target and
// draws the host's snapshots. Text messages are passed between the two sides of a room.
const rooms = new Map(); // room -> { host: ws | null, guests: Set<ws> }
function duelConnect(ws, q) {
  const room = q.get('room'), side = q.get('side') === 'host' ? 'host' : 'guest';
  if (!/^[a-z0-9]{4,12}$/.test(room || '')) { ws.close(); return; }
  let r = rooms.get(room);
  if (!r) rooms.set(room, (r = { host: null, guests: new Set() }));
  if (side === 'host') { if (r.host && r.host !== ws) { try { r.host.close(); } catch {} } r.host = ws; } else r.guests.add(ws);
  const status = () => {
    if (r.host?.readyState === 1) r.host.send(JSON.stringify({ type: 'peer', guests: r.guests.size }));
    for (const g of r.guests) if (g.readyState === 1) g.send(JSON.stringify({ type: 'peer', host: !!r.host }));
  };
  console.log(`[duel] ${side} joined room ${room}`);
  status();
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString();
    const to = side === 'host' ? [...r.guests] : r.host ? [r.host] : [];
    for (const p of to) if (p.readyState === 1) p.send(text);
  });
  ws.on('close', () => {
    if (side === 'host') { if (r.host === ws) r.host = null; } else r.guests.delete(ws);
    console.log(`[duel] ${side} left room ${room}`);
    status();
    if (!r.host && !r.guests.size) rooms.delete(room);
  });
}

// ---------------------------------------------------------------- http handler
let INFO = null;
function handler(proto) {
  return async (req, res) => {
    const url = new URL(req.url, `${proto}://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    try {
      if (p === '/info') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ...INFO, phones: phoneCount(), zig: { port: ZIG_PORT, packets: zig.packets, from: zig.from, ageMs: zig.last ? Date.now() - zig.last : null } }));
        return;
      }
      if (p === '/qr.svg') {
        // only ever encode our own phone URL (optionally for a seat: ?seat=<id>&p=<player number>)
        const seat = seatParam(url.searchParams.get('seat')), pn = /^[1-9]$/.test(url.searchParams.get('p') || '') ? url.searchParams.get('p') : null;
        const target = seat ? `${INFO.phoneUrl}?seat=${seat}${pn ? `&p=${pn}` : ''}` : INFO.phoneUrl;
        const svg = await QRCode.toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000', light: '#fff' } });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        res.end(svg);
        return;
      }
      if (p === '/ca.crt') {
        res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="GyroSwordCA.crt"' });
        res.end(INFO.caPem);
        return;
      }
      if (p === '/rtc/offer' && req.method === 'POST') {
        const id = url.searchParams.get('id') || '';
        if (!/^[a-z0-9]{4,16}$/.test(id)) { res.writeHead(400); res.end(); return; }
        const seat = seatParam(url.searchParams.get('seat'));
        if (![...games].some((g) => g.seat === seat)) { res.writeHead(503); res.end('no game'); return; }
        const { sdp } = JSON.parse((await readBody(req, 1 << 16)).toString());
        const phoneIp = plainIp(req.socket.remoteAddress);
        for (const [k, v] of rtcSessions) if (Date.now() - v.t > 60000) rtcSessions.delete(k);
        const target = /^[a-z0-9]{4,16}$/.test(url.searchParams.get('for') || '') ? url.searchParams.get('for') : null;
        rtcSessions.set(id, { phoneIp, answer: null, t: Date.now(), for: target });
        toGames(JSON.stringify({ type: 'rtc-offer', id, sdp: unmaskCandidates(sdp, phoneIp), for: target }), false, seat);
        console.log(`[rtc] offer from ${id} (${phoneIp})${target ? ` for game ${target}` : ''}${seat ? ` seat ${seat}` : ''}`);
        res.writeHead(202); res.end();
        return;
      }
      if (p === '/rtc/answer') {
        const s = rtcSessions.get(url.searchParams.get('id') || '');
        if (!s || !s.answer) { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ sdp: s.answer }));
        return;
      }
      if (p === '/up' && req.method === 'POST') {
        // HTTP uplink fallback: body = concatenated 80-byte sensor packets, or JSON text if ?t=1
        const id = url.searchParams.get('id') || 'x';
        let entry = httpPhones.get(id);
        // last must be fresh before announce(): phoneCount() expires stale entries
        if (!entry) { entry = { last: Date.now(), queue: [], seat: seatParam(url.searchParams.get('seat')) }; httpPhones.set(id, entry); console.log(`[http] phone ${id} uplink`); announce(); }
        entry.last = Date.now();
        const body = await readBody(req, 1 << 16);
        if (url.searchParams.get('t') === '1') toGames(body.toString(), false, entry.seat);
        else for (let o = 0; o + 80 <= body.length; o += 80) toGames(body.subarray(o, o + 80), true, entry.seat);
        const out = entry.queue.splice(0);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(out));
        return;
      }
      if (p === '/rec' && req.method === 'POST') {
        if (!isLocal(req)) { res.writeHead(403); res.end(); return; }
        const body = await readBody(req, 200 << 20);
        fs.mkdirSync(REC_DIR, { recursive: true });
        const name = `rec-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        fs.writeFileSync(path.join(REC_DIR, name), body);
        console.log(`[rec] saved recordings/${name} (${(body.length / 1024).toFixed(0)} KB)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name }));
        return;
      }
      if (p.startsWith('/rec/') && req.method === 'GET') {
        // recordings back to local pages (in-browser replays, public/qa/)
        const name = path.basename(p.slice(5));
        const f = path.join(REC_DIR, name);
        if (!isLocal(req) || !name.endsWith('.json') || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        fs.createReadStream(f).pipe(res);
        return;
      }
      if (p === '/duel' || p === '/duel/') { sendFile(res, path.join(ROOT, 'public/duel.html')); return; }
      if (p === '/phone' || p === '/phone/') {
        // Phone must be on HTTPS for motion sensors.
        if (proto === 'http' && !isLocal(req)) {
          res.writeHead(302, { Location: INFO.phoneUrl });
          res.end();
          return;
        }
        sendFile(res, path.join(ROOT, 'public/phone.html'));
        return;
      }
      const file = resolveStatic(p === '/' ? '/index.html' : p);
      if (!file) { res.writeHead(404); res.end('not found'); return; }
      sendFile(res, file);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500);
      res.end('error');
    }
  };
}

function upgrade(server) {
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}

// ---------------------------------------------------------------- ZIG SIM Pro (iOS app) over UDP
// The app streams its motion sensors, touches and ARKit tracking as JSON datagrams. They're relayed to
// the game pages as {type:'zig', d, at}; the first packets of each session are also kept raw on disk
// (recordings/zigsim-raw.txt) so the exact message format can be checked.
const zig = { packets: 0, from: null, last: 0, raw: [], format: null };
// Several ZIG SIM phones (multiplayer): each device (its uuid) belongs to the seat that claimed it — a seat
// page asks ('zig-claim'), and the next touched phone that isn't another live seat's becomes its own.
// Devices nobody owns go to the pages without a seat, like before.
const zigOwners = new Map(); // device key -> seat
let zigClaim = null;          // { seat, t }
function zigControl(ws, m) {
  if (!ws.seat) return;
  if (m.type === 'zig-claim') { zigClaim = { seat: ws.seat, t: Date.now() }; console.log(`[zig] seat ${ws.seat} waits for a touched ZIG SIM`); }
  else if (m.type === 'zig-release') {
    for (const [k, s] of zigOwners) if (s === ws.seat) zigOwners.delete(k);
    if (zigClaim?.seat === ws.seat) zigClaim = null;
  }
}
const zigTouched = (sd) => (Array.isArray(sd.touch) ? sd.touch.length > 0 : Object.keys(sd).some((k) => /^touch\d/i.test(k)));

// OSC (ZIG SIM's default format): "#bundle" + timetag + sized elements; a message is an address, a type
// tag string and big-endian arguments, every string NUL-terminated and padded to 4 bytes.
function oscString(buf, o) {
  let e = o;
  while (e < buf.length && buf[e] !== 0) e++;
  return [buf.toString('utf8', o, e), (e + 4) & ~3];
}
function oscParse(buf, o = 0, end = buf.length, out = []) {
  if (end - o >= 16 && buf.toString('ascii', o, o + 7) === '#bundle') {
    // NTP timetag (seconds since 1900 + 2^-32 fraction); 1 means "immediately"
    const sec = buf.readUInt32BE(o + 8), frac = buf.readUInt32BE(o + 12);
    if (out.timetag === undefined) out.timetag = sec === 0 && frac === 1 ? null : (sec - 2208988800) * 1000 + (frac / 4294967296) * 1000;
    o += 16;
    while (o + 4 <= end) {
      const n = buf.readInt32BE(o); o += 4;
      if (n <= 0 || o + n > end) break;
      oscParse(buf, o, o + n, out);
      o += n;
    }
    return out;
  }
  let addr, tags;
  [addr, o] = oscString(buf, o);
  [tags, o] = oscString(buf, o);
  const args = [];
  for (const t of tags.slice(1)) {
    if (o > end) break;
    if (t === 'f') { args.push(buf.readFloatBE(o)); o += 4; }
    else if (t === 'i') { args.push(buf.readInt32BE(o)); o += 4; }
    else if (t === 'd') { args.push(buf.readDoubleBE(o)); o += 8; }
    else if (t === 'h') { args.push(Number(buf.readBigInt64BE(o))); o += 8; }
    else if (t === 's') { let s; [s, o] = oscString(buf, o); args.push(s); }
    else if (t === 'T' || t === 'F') args.push(t === 'T');
    else if (t === 'b') { const n = buf.readInt32BE(o); o += 4 + ((n + 3) & ~3); args.push(null); }
    else break;
  }
  out.push({ addr, tags, args });
  return out;
}
// OSC messages -> the same shape as ZIG SIM's JSON ({ device, sensordata: { <key>: [...] } }), with
// ARKit device tracking also as sensordata.arkit = { position, rotation } like the JSON format
function oscToZig(msgs) {
  const d = { device: {}, sensordata: {} };
  for (const { addr, args } of msgs) {
    const key = addr.split('/').filter(Boolean).pop();
    if (key === 'deviceinfo') {
      const [name, uuid, os, osversion, width, height] = args;
      d.device = { name, uuid, os, osversion, displaywidth: width, displayheight: height };
    } else if (key === 'arkitfeaturepoints') {
      d.sensordata.arkitfeaturepoints = { count: Math.floor(args.length / 3) }; // the cloud itself is too big to relay
    } else d.sensordata[key] = args;
  }
  const sd = d.sensordata;
  if (sd.arkitposition || sd.arkitrotation) sd.arkit = { position: sd.arkitposition, rotation: sd.arkitrotation };
  return d;
}

function startZig() {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (buf, rinfo) => {
    const now = Date.now();
    if (now - zig.last > 5000) { zig.raw = []; zig.format = null; console.log(`[zig] stream from ${rinfo.address}:${rinfo.port}`); }
    zig.last = now; zig.packets++; zig.from = rinfo.address;
    let d = null, rawText;
    if (buf[0] === 0x7b) { // '{' JSON
      rawText = buf.toString('utf8');
      try { d = JSON.parse(rawText); } catch {}
      if (d && zig.format !== 'json') { zig.format = 'json'; console.log('[zig] JSON format'); }
    } else {
      let msgs = [];
      try { msgs = oscParse(buf); } catch {}
      if (msgs.length) { d = oscToZig(msgs); if (msgs.timetag != null) d.sent = msgs.timetag; }
      rawText = `timetag ${msgs.timetag} (arrived ${now}, diff ${msgs.timetag != null ? (now - msgs.timetag).toFixed(1) : '-'} ms)
` + msgs.map((m) => `${m.addr} ${m.tags} ${m.args.length > 12 ? `[${m.args.length} values] ${m.args.slice(0, 6).join(', ')} …` : m.args.join(', ')}`).join('\n');
      if (d && zig.format !== 'osc') { zig.format = 'osc'; console.log(`[zig] OSC format: ${msgs.map((m) => m.addr.split('/').pop()).join(', ')}`); }
    }
    if (zig.raw.length < 30) {
      zig.raw.push(`--- ${new Date(now).toISOString()} ${buf.length} bytes\n${rawText}`);
      if (zig.raw.length === 1 || zig.raw.length === 30) {
        fs.mkdirSync(REC_DIR, { recursive: true });
        fs.writeFileSync(path.join(REC_DIR, 'zigsim-raw.txt'), zig.raw.join('\n\n'));
      }
    }
    if (!d) return;
    if (d.sensordata?.arkitfeaturepoints?.length > 300) d.sensordata.arkitfeaturepoints = { count: d.sensordata.arkitfeaturepoints.length / 3 };
    const key = d.device?.uuid || rinfo.address;
    let seat = zigOwners.get(key) ?? null;
    if (seat && !seatLive(seat)) seat = null; // its page is gone: free again (until claimed)
    if (zigClaim && now - zigClaim.t > 120000) zigClaim = null;
    if (!seat && zigClaim && zigTouched(d.sensordata || {})) {
      seat = zigClaim.seat; zigClaim = null;
      for (const [k, s] of zigOwners) if (s === seat) zigOwners.delete(k); // one phone per seat
      zigOwners.set(key, seat);
      console.log(`[zig] ${d.device?.name || key} -> seat ${seat}`);
      toGames(JSON.stringify({ type: 'zig-assigned', name: d.device?.name || key }), false, seat);
    }
    const msg = JSON.stringify({ type: 'zig', d, at: now });
    if (seat) toGames(msg, false, seat);
    else {
      toGames(msg, false, null);
      // the seat waiting for a ZIG phone hears that one is streaming (a few times a second)
      if (zigClaim && now - (zig.freeAt || 0) > 300) { zig.freeAt = now; toGames(JSON.stringify({ type: 'zig-free', name: d.device?.name || key }), false, zigClaim.seat); }
    }
  });
  sock.on('error', (e) => console.log(`[zig] UDP ${ZIG_PORT}: ${e.message}`));
  sock.bind(ZIG_PORT, '0.0.0.0');
}

// ---------------------------------------------------------------- start
const ips = lanIPs();
const ipList = ips.map((i) => i.address);
const certs = ensureCerts(ipList);
const mainIP = ipList[0] || '127.0.0.1';
INFO = {
  ips: ipList,
  httpPort: HTTP_PORT,
  httpsPort: HTTPS_PORT,
  phoneUrl: `https://${mainIP}:${HTTPS_PORT}/phone`,
  caUrl: `http://${mainIP}:${HTTP_PORT}/ca.crt`,
  caPem: certs.caPem.toString(),
};

const httpServer = http.createServer(handler('http'));
const httpsServer = https.createServer({ key: certs.key, cert: certs.cert }, handler('https'));
upgrade(httpServer);
upgrade(httpsServer);
startZig();
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  GyroSword server');
    console.log(`  게임 (PC 브라우저) : http://localhost:${HTTP_PORT}`);
    console.log(`  폰 컨트롤러        : ${INFO.phoneUrl}`);
    console.log(`  (선택) 인증서 설치 : ${INFO.caUrl}`);
    console.log(`  ZIG SIM (UDP JSON) : ${mainIP} 포트 ${ZIG_PORT}`);
    console.log('');
  });
});
