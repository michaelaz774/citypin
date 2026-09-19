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

test('end to end: a pin reaches everyone, votes count once per browser, a late joiner is synced', async () => {
  const srv = await createServer({ port: 0, log: () => {}, pinsPath: null });
  try {
    const a = await connect(srv.port), b = await connect(srv.port);
    await next(a, P.S2C.WELCOME); await next(b, P.S2C.WELCOME);
    assert.equal(P.decodePinSync(await next(a, P.S2C.PIN_SYNC)).length, 0, 'an empty city still syncs');
    await next(b, P.S2C.PIN_SYNC);
    a.send(P.encodeName('Aubrey', 111)); b.send(P.encodeName('West End', 222));
    a.send(P.encodeState(0, 0, 0, 0, 0, 0)); b.send(P.encodeState(10, 0, 10, 0, 0, 0));
    a.send(P.encodePlacePin(2, 20, 30, ' floods  every storm '));
    const pa = P.decodePinAdd(await next(a, P.S2C.PIN_ADD)), pb = P.decodePinAdd(await next(b, P.S2C.PIN_ADD));
    assert.equal(pa.id, pb.id); assert.equal(pb.note, 'floods every storm');
    assert.deepEqual([pa.cat, pa.x, pa.z, pa.votes], [2, 20, 30, 1]);
    b.send(P.encodeUpvotePin(pa.id));
    const va = P.decodePinVote(await next(a, P.S2C.PIN_VOTE)), vb = P.decodePinVote(await next(b, P.S2C.PIN_VOTE));
    assert.deepEqual([va.id, va.votes], [pa.id, 2]); assert.deepEqual([vb.id, vb.votes], [pa.id, 2]);
    a.send(P.encodeUpvotePin(pa.id)); // the reporter's vote is already in the count
    await assert.rejects(next(a, P.S2C.PIN_VOTE, 300), /timeout/, 'a vote that changes nothing is not broadcast');
    const c = await connect(srv.port); await next(c, P.S2C.WELCOME);
    const pins = P.decodePinSync(await next(c, P.S2C.PIN_SYNC));
    assert.equal(pins.length, 1);
    assert.deepEqual([pins[0].id, pins[0].note, pins[0].votes], [pa.id, 'floods every storm', 2]);
    const m = await fetch(`http://127.0.0.1:${srv.port}/metrics`).then((r) => r.json());
    assert.equal(m.pins, 1);
    a.close(); b.close(); c.close();
  } finally { await srv.close(); }
});

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
test('end to end: pins outlive the process', async () => {
  const dir = mkdtempSync(nodePath.join(os.tmpdir(), 'citypin-relay-'));
  const pinsPath = nodePath.join(dir, 'state', 'pins.json'); // the directory is created on the first save
  try {
    const first = await createServer({ port: 0, log: () => {}, pinsPath });
    let placed;
    try {
      const a = await connect(first.port); await next(a, P.S2C.WELCOME); await next(a, P.S2C.PIN_SYNC);
      a.send(P.encodeName('Aubrey', 424242)); a.send(P.encodeState(2, 0, 2, 0, 0, 0));
      a.send(P.encodePlacePin(4, 12, -8, 'no shelter at the stop'));
      placed = P.decodePinAdd(await next(a, P.S2C.PIN_ADD));
      a.close();
    } finally { await first.close(); }
    const second = await createServer({ port: 0, log: () => {}, pinsPath });
    try {
      const c = await connect(second.port); await next(c, P.S2C.WELCOME);
      const pins = P.decodePinSync(await next(c, P.S2C.PIN_SYNC));
      assert.equal(pins.length, 1);
      assert.deepEqual([pins[0].id, pins[0].cat, pins[0].note, pins[0].votes], [placed.id, 4, 'no shelter at the stop', 1]);
      assert.equal(second.world.store.nextId, placed.id + 1, 'ids carry on where they stopped');
      c.close();
    } finally { await second.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
