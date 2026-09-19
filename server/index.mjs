// CityPin relay server: `ws` transport around World. Absolute-time 10 Hz tick, phase-spread sends,
// backpressure drops (latest-wins), /metrics for the load test.
import { WebSocketServer } from 'ws';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { World, ROSTER_TICKS } from './world.mjs';
import { C2S, decodeState, decodeName, encodeWelcome, encodePong, encodeNameOf } from '../shared/protocol.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT ?? 8790);
const TICK_MS = 100, SEND_PHASES = 5;
const MAX_BUFFERED = 64 * 1024;
const HOST = process.env.HOST ?? '0.0.0.0';                 // production binds 127.0.0.1: Caddy is the only way in
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean); // empty = any (dev)
const MAX_PER_IP = +(process.env.MAX_PER_IP ?? 64);         // sockets per client address (behind Caddy: X-Forwarded-For); NATs share one, so be generous
const MSG_RATE = +(process.env.MSG_RATE ?? 40), MSG_BURST = +(process.env.MSG_BURST ?? 80); // a normal client sends ~15/s
/** Origin allow-list: exact match, or any subdomain of an entry written as ".example.com" (Pages preview URLs). No Origin = not a browser = refused. */
export function originAllowed(origin, allowed = ALLOWED_ORIGINS) {
  if (!allowed.length) return true;
  if (!origin) return false;
  let host; try { host = new URL(origin).host; } catch { return false; }
  return allowed.some((a) => a === origin || (a.startsWith('.') && (host.endsWith(a) || host === a.slice(1))));
}
const clientIp = (req) => (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '?';

export function createServer({ port = PORT, host = HOST, dataPath = path.join(__dirname, '../public/data/toronto.json'), log = console.log, allowedOrigins = ALLOWED_ORIGINS, maxPerIp = MAX_PER_IP, msgRate = MSG_RATE, msgBurst = MSG_BURST } = {}) {
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  const cos = Math.cos((data.origin.lat * Math.PI) / 180);
  const toLocal = (lat, lon) => ({ x: (lon - data.origin.lon) * cos * 111320, z: -(lat - data.origin.lat) * 110574 });
  const sw = toLocal(data.bbox.south, data.bbox.west), ne = toLocal(data.bbox.north, data.bbox.east);
  const world = new World({ minX: sw.x, maxX: ne.x, minZ: ne.z, maxZ: sw.z });

  const sockets = new Map(); // id -> ws
  const tickTimes = []; let bytesOut = 0, bytesOutWindow = 0, lastWindow = performance.now(), bytesPerSec = 0;
  const loopDelay = monitorEventLoopDelay({ resolution: 10 }); loopDelay.enable();
  const pct = (arr, p) => { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/metrics') {
      const m = { players: sockets.size, refusedOrigin: stats.refusedOrigin, refusedIp: stats.refusedIp, kickedRate: stats.kickedRate, tickP50: pct(tickTimes, 0.5), tickP95: pct(tickTimes, 0.95), tickP99: pct(tickTimes, 0.99),
        loopDelayP99Ms: loopDelay.percentile(99) / 1e6, bytesOutPerSec: bytesPerSec, drops: world.stats.droppedForBackpressure, rssMB: Math.round(process.memoryUsage().rss / 1e6), tick: world.tick };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(m)); return;
    }
    if (req.url === '/players') { // ops view: who is online, where, and how stale
      const now = performance.now(); const out = [];
      for (let s = 0; s < world.maxPlayers; s++) if (world.alive[s]) out.push({ id: s + 1, x: Math.round(world.px[s]), y: Math.round(world.py[s]), z: Math.round(world.pz[s]), flags: world.flags[s], silentMs: Math.round(now - world.lastSeen[s]), socket: sockets.has(s + 1) });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out)); return;
    }
    res.statusCode = 200; res.end('CityPin relay');
  });
  const perIp = new Map(); // ip -> open sockets
  const stats = { refusedOrigin: 0, refusedIp: 0, kickedRate: 0 };
  const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false, maxPayload: 64,
    verifyClient: ({ req, origin }, done) => {
      if (!originAllowed(origin, allowedOrigins)) { stats.refusedOrigin++; return done(false, 403, 'origin'); }
      if ((perIp.get(clientIp(req)) ?? 0) >= maxPerIp) { stats.refusedIp++; return done(false, 429, 'too many connections'); }
      done(true);
    } });
  const st = {};
  const sendTo = (id, pkt) => { const ws = sockets.get(id); if (ws && ws.readyState === 1 && ws.bufferedAmount <= MAX_BUFFERED) { ws.send(pkt, { binary: true }); bytesOut += pkt.byteLength; bytesOutWindow += pkt.byteLength; } };
  const broadcast = (pkt) => { for (const id of sockets.keys()) sendTo(id, pkt); };
  wss.on('connection', (ws, req) => {
    const now = performance.now();
    const id = world.join(now);
    if (id < 0) { ws.close(1013, 'full'); return; }
    ws._id = id; sockets.set(id, ws); log(`[relay] join #${id} (${sockets.size} online)`);
    const ip = clientIp(req); perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    let tokens = msgBurst, lastFill = now; // token bucket: msgRate/s sustained, msgBurst at once
    ws._socket?.setNoDelay?.(true);
    ws.send(encodeWelcome(id), { binary: true });
    ws.on('message', (buf, isBinary) => {
      if (!isBinary || buf.length < 1) return;
      const t = performance.now();
      tokens = Math.min(msgBurst, tokens + ((t - lastFill) / 1000) * msgRate); lastFill = t;
      if (--tokens < 0) { stats.kickedRate++; log(`[relay] rate kick #${id}`); ws.close(1008, 'rate'); return; }
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
      switch (dv.getUint8(0)) {
        case C2S.STATE: if (buf.length >= 10) world.setState(id, decodeState(dv, st), t); break;
        case C2S.PING: if (buf.length >= 5) ws.send(encodePong(dv.getUint32(1, true)), { binary: true }); break;
        case C2S.NAME: { if (buf.length < 2) break; const nm = decodeName(dv); if (world.setName(id, nm.name, nm.token)) broadcast(encodeNameOf(id, world.nameOf(id))); break; }
        case C2S.WHO: { if (buf.length < 3) break; const who = dv.getUint16(1, true); const n = world.nameOf(who); if (n !== null) ws.send(encodeNameOf(who, n), { binary: true }); break; }
      }
    });
    ws.on('close', (code) => { if (sockets.get(id) === ws) sockets.delete(id); world.leave(id);
      const n = (perIp.get(ip) ?? 1) - 1; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n); log(`[relay] leave #${id} code ${code} (${sockets.size} online)`); });
    ws.on('error', () => {});
  });

  // absolute-time loop: schedule each tick at start + n*TICK_MS so drift never accumulates
  let running = true; const t0 = performance.now(); let n = 0;
  const loop = () => {
    if (!running) return;
    const now = performance.now();
    const gone = world.expire(now);
    for (const id of gone) { const s = sockets.get(id); if (s) { log(`[relay] timeout #${id}`); s.close(1000, 'timeout'); sockets.delete(id); } }
    const packets = world.step();
    if (world.tick % ROSTER_TICKS === 0) { const roster = world.rosterPacket(); for (const ws of sockets.values()) if (ws.readyState === 1 && ws.bufferedAmount <= MAX_BUFFERED) { ws.send(roster, { binary: true }); bytesOut += roster.byteLength; bytesOutWindow += roster.byteLength; } }
    // phase-spread: clients bucketed by id, sent over SEND_PHASES sub-slots to avoid one 1.6 MB burst
    const buckets = Array.from({ length: SEND_PHASES }, () => []);
    for (const [slot, pkt] of packets) buckets[(slot + 1) % SEND_PHASES].push([slot + 1, pkt]);
    buckets.forEach((b, i) => {
      const send = () => { for (const [id, pkt] of b) { const ws = sockets.get(id); if (!ws || ws.readyState !== 1) continue;
        if (ws.bufferedAmount > MAX_BUFFERED) { world.stats.droppedForBackpressure++; continue; }
        ws.send(pkt, { binary: true }); bytesOut += pkt.byteLength; bytesOutWindow += pkt.byteLength; } };
      i === 0 ? send() : setTimeout(send, (i * TICK_MS) / SEND_PHASES);
    });
    const dt = performance.now() - now; tickTimes.push(dt); if (tickTimes.length > 600) tickTimes.shift();
    if (now - lastWindow >= 1000) { bytesPerSec = bytesOutWindow / ((now - lastWindow) / 1000); bytesOutWindow = 0; lastWindow = now; }
    n++; const next = t0 + n * TICK_MS - performance.now();
    setTimeout(loop, Math.max(0, next));
  };

  return new Promise((resolve) => {
    httpServer.listen(port, host, () => {
      log(`[relay] listening on ${host}:${httpServer.address().port} · ${world.maxPlayers} slots`);
      setTimeout(loop, TICK_MS);
      resolve({ world, wss, httpServer, port: httpServer.address().port, close: () => new Promise((r) => { running = false; for (const s of sockets.values()) s.terminate(); wss.close(); httpServer.close(() => r()); }) });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) createServer();
