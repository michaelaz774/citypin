import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createServer } from '../server/index.mjs';
import * as P from '../shared/protocol.mjs';

// messages are queued from 'open' so nothing that arrives before a listener is attached is lost
const connect = (port) => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${port}`); ws.binaryType = 'arraybuffer'; ws.q = []; ws.on('message', (d) => ws.q.push(d)); ws.on('open', () => res(ws)); ws.on('error', rej); });
const next = (ws, type, ms = 2000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const poll = () => { const i = ws.q.findIndex((d) => new DataView(d).getUint8(0) === type); if (i >= 0) return res(new DataView(ws.q.splice(0, i + 1)[i]));
    if (Date.now() - t0 > ms) return rej(new Error(`timeout waiting for ${type}`)); setTimeout(poll, 5); };
  poll();
});

test('end to end: welcome, snapshots, pong, metrics', async () => {
  const srv = await createServer({ port: 0, log: () => {} });
  const timers = []; // cleared in finally so a failed assertion cannot keep the event loop alive
  try {
    const a = await connect(srv.port), b = await connect(srv.port);
    const wa = P.decodeWelcome(await next(a, P.S2C.WELCOME)), wb = P.decodeWelcome(await next(b, P.S2C.WELCOME));
    assert.notEqual(wa.myId, wb.myId);
    // both stand a couple of metres apart and stream state
    const tick = setInterval(() => { a.send(P.encodeState(1, 0, 1, 0, 0, P.FLAG.MOVING)); b.send(P.encodeState(-1, 0, -1, 0, 0, 0)); }, 50); timers.push(tick);
    const players = []; P.decodeSnapshot(await next(a, P.S2C.SNAPSHOT, 3000), players);
    assert.ok(players.some((p) => p.id === wb.myId), 'a sees b');
    a.send(P.encodePing(1234)); const pong = await next(a, P.S2C.PONG); assert.equal(pong.getUint32(1, true), 1234);
    const m = await fetch(`http://127.0.0.1:${srv.port}/metrics`).then((r) => r.json());
    assert.equal(m.players, 2);
    clearInterval(tick);
    a.close(); b.close(); await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.world.playerCount, 0);
  } finally { for (const t of timers) clearInterval(t); await srv.close(); }
});

test('end to end: names reach other clients and WHO answers', async () => {
  const srv = await createServer({ port: 0, log: () => {} });
  try {
    const a = await connect(srv.port), b = await connect(srv.port);
    const wa = P.decodeWelcome(await next(a, P.S2C.WELCOME)); await next(b, P.S2C.WELCOME);
    a.send(P.encodeName('Aubrey')); b.send(P.encodeName('Toronto Man'));
    let nb = null; for (let i = 0; i < 4 && !nb; i++) { const n = P.decodeNameOf(await next(b, P.S2C.NAME), {}); if (n.id === wa.myId) nb = n; } // names are broadcast to everyone, b's own echo may come first
    assert.ok(nb && nb.name === 'Aubrey', 'b hears the name a chose');
    b.send(P.encodeWho(wa.myId)); let who = null; for (let i = 0; i < 4 && !who; i++) { const n = P.decodeNameOf(await next(b, P.S2C.NAME), {}); if (n.id === wa.myId) who = n; } // skip b's own echo
    assert.ok(who && who.name === 'Aubrey', 'WHO answers with the name');
    a.close(); b.close();
  } finally { await srv.close(); }
});

import { originAllowed } from '../server/index.mjs';
test('origin allow-list: exact hosts, dot-prefixed wildcard subdomains, nothing when no Origin', () => {
  const allowed = ['https://citypin.example', '.citypin.pages.dev'];
  assert.equal(originAllowed('https://citypin.example', allowed), true);
  assert.equal(originAllowed('https://abc123.citypin.pages.dev', allowed), true);
  assert.equal(originAllowed('https://citypin.pages.dev', allowed), true);
  assert.equal(originAllowed('https://evil.example', allowed), false);
  assert.equal(originAllowed('https://citypin.example.evil.example', allowed), false);
  assert.equal(originAllowed(undefined, allowed), false, 'scripts without an Origin are refused');
  assert.equal(originAllowed(undefined, []), true, 'no list configured (dev): anything goes');
});

test('end to end: bad origins are refused, a flooding client is kicked, per-IP cap holds', async () => {
  const srv = await createServer({ port: 0, log: () => {}, allowedOrigins: ['http://ok.test'], maxPerIp: 2, msgRate: 20, msgBurst: 30 });
  try {
    const open = (origin) => new Promise((res, rej) => { const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`, origin ? { headers: { origin } } : {}); ws.on('open', () => res(ws)); ws.on('error', rej); ws.on('unexpected-response', (_r, resp) => rej(new Error(String(resp.statusCode)))); });
    await assert.rejects(open('http://evil.test'), /403/, 'wrong origin');
    await assert.rejects(open(undefined), /403/, 'no origin');
    const a = await open('http://ok.test'), b = await open('http://ok.test');
    await assert.rejects(open('http://ok.test'), /429/, 'third socket from the same address');
    const closed = new Promise((res) => a.on('close', (code) => res(code)));
    for (let i = 0; i < 60; i++) a.send(P.encodePing(i)); // 60 at once, burst allows 30
    assert.equal(await closed, 1008, 'flooder closed with policy violation');
    b.close();
    await new Promise((r) => setTimeout(r, 50));
    const c = await open('http://ok.test'); c.close(); // slots freed once sockets close
  } finally { await srv.close(); }
});
