import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../shared/protocol.mjs';

const near = (a, b, eps = 0.02) => Math.abs(a - b) < eps; // u8 pitch has no exact zero (127.5 rounds to 128)

test('player record round-trips within quantization', () => {
  const b = new ArrayBuffer(P.PLAYER_REC), dv = new DataView(b);
  P.writePlayer(dv, 0, 1234, -701.3, 12.6, -1990.1, 4.9, -0.7, P.FLAG.FLYING | P.FLAG.MOVING);
  const o = {}; P.readPlayer(dv, 0, o);
  assert.equal(o.id, 1234);
  assert.ok(Math.abs(o.x + 701.3) <= 0.125 && Math.abs(o.y - 12.6) <= 0.125 && Math.abs(o.z + 1990.1) <= 0.125);
  assert.ok(Math.abs(Math.atan2(Math.sin(o.yaw - 4.9), Math.cos(o.yaw - 4.9))) < 0.03);
  assert.ok(Math.abs(o.pitch + 0.7) < 0.02);
  assert.equal(o.flags, P.FLAG.FLYING | P.FLAG.MOVING);
});

test('positions clamp at ±8 km instead of wrapping', () => {
  assert.equal(P.qPos(9000), 32767); assert.equal(P.qPos(-9000), -32768);
});

test('state / welcome / snapshot encode+decode', () => {
  const st = P.decodeState(new DataView(P.encodeState(10, 2, -3, 1, 0.2, 4)), {});
  assert.deepEqual([st.x, st.y, st.z, st.flags], [10, 2, -3, 4]);
  assert.ok(near(st.pitch, 0.2));
  const w = P.decodeWelcome(new DataView(P.encodeWelcome(42)));
  assert.equal(w.myId, 42); assert.equal(P.encodeWelcome(42).byteLength, 3);
  const buf = new ArrayBuffer(3 + 2 * P.PLAYER_REC), dv = new DataView(buf);
  dv.setUint8(0, P.S2C.SNAPSHOT); dv.setUint16(1, 2, true);
  P.writePlayer(dv, 3, 9, 1, 2, 3, 0, 0, 0); P.writePlayer(dv, 3 + P.PLAYER_REC, 11, -4, 0, 5, 0, 0, P.FLAG.MOVING);
  const players = []; P.decodeSnapshot(dv, players);
  assert.deepEqual(players.map((p) => p.id), [9, 11]);
  assert.equal(players[1].x, -4); assert.equal(players[1].flags, P.FLAG.MOVING);
});

test('names round-trip; names are cleaned and capped at 12 characters', () => {
  assert.equal(P.cleanName('  '), 'Resident'); assert.equal(P.cleanName('a   b'), 'a b'); assert.equal(P.cleanName('abcdefghijklmnop'), 'abcdefghijkl');
  assert.deepEqual(P.decodeName(new DataView(P.encodeName('  West End  ', 123456789))), { name: 'West End', token: 123456789 });
  assert.equal(P.decodeName(new DataView(P.encodeName('Été 2026'))).name, 'Été 2026');
  const n = P.decodeNameOf(new DataView(P.encodeNameOf(4097, 'Scarborough')), {}); assert.equal(n.id, 4097); assert.equal(n.name, 'Scarborough');
  assert.ok(P.encodeName('x'.repeat(200)).byteLength <= 54, 'a name packet always fits under the relay 64-byte cap');
});

test('ping/pong carry the client timestamp untouched', () => {
  const p = new DataView(P.encodePing(0xfeedface)); assert.equal(p.getUint8(0), P.C2S.PING); assert.equal(p.getUint32(1, true), 0xfeedface);
  const q = new DataView(P.encodePong(0xfeedface)); assert.equal(q.getUint8(0), P.S2C.PONG); assert.equal(q.getUint32(1, true), 0xfeedface);
  const wh = new DataView(P.encodeWho(77)); assert.equal(wh.getUint8(0), P.C2S.WHO); assert.equal(wh.getUint16(1, true), 77);
});

test('roster round-trips at 1 m', () => {
  const out = []; P.decodeRoster(new DataView(P.encodeRoster([{ id: 7, x: -650.4, z: -2130.6 }, { id: 9, x: 3999, z: 12 }])), out);
  assert.deepEqual(out, [{ id: 7, x: -650, z: -2131 }, { id: 9, x: 3999, z: 12 }]);
});
