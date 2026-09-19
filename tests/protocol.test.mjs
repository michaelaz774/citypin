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


const bytes = (s) => new TextEncoder().encode(s).length;
test('pin notes are cleaned and cut to 48 bytes on a character boundary', () => {
  assert.equal(P.cleanNote('  curb\u0007   cut  '), 'curb cut');
  assert.equal(P.cleanNote(null), '');
  assert.equal(P.cleanNote('x'.repeat(47) + 'é'), 'x'.repeat(47), 'a cut never leaves half a code point');
  assert.equal(P.cleanNote('é'.repeat(40)), 'é'.repeat(24));
  assert.ok(bytes(P.cleanNote('é'.repeat(40))) <= P.NOTE_MAX);
  assert.equal(P.encodePlacePin(0, 0, 0, 'x'.repeat(48)).byteLength, 59, 'the longest pin still fits the 64-byte relay cap');
  assert.equal(P.PIN_CATEGORIES.length, 7);
});

test('place / upvote round-trip', () => {
  const p = P.decodePlacePin(new DataView(P.encodePlacePin(3, -120.5, 88.25, ' flooded\u0001  underpass ')), {});
  assert.deepEqual([p.cat, p.x, p.z, p.note], [3, -120.5, 88.25, 'flooded underpass']);
  const empty = P.decodePlacePin(new DataView(P.encodePlacePin(0, 1, 2, '')), {});
  assert.deepEqual([empty.note, empty.x, empty.z], ['', 1, 2]);
  const u = new DataView(P.encodeUpvotePin(4000000000));
  assert.equal(u.getUint8(0), P.C2S.UPVOTE_PIN); assert.equal(P.decodeUpvotePin(u), 4000000000);
});

test('pin add / sync / vote round-trip', () => {
  const one = { id: 70000, cat: 6, x: -650.25, z: 2130.5, note: 'no curb cut', votes: 3, t: 1750000000 };
  const two = { id: 1, cat: 2, x: 4, z: -4, note: 'côté est: trop étroit', votes: 1, t: 1750000001 };
  const a = P.decodePinAdd(new DataView(P.encodePinAdd(one)));
  assert.deepEqual([a.id, a.cat, a.x, a.z, a.note, a.votes, a.t], [70000, 6, -650.25, 2130.5, 'no curb cut', 3, 1750000000]);
  const sync = P.decodePinSync(new DataView(P.encodePinSync([one, two])));
  assert.equal(sync.length, 2);
  assert.deepEqual(sync.map((p) => p.id), [70000, 1]);
  assert.equal(sync[1].note, 'côté est: trop étroit', 'a multibyte note survives a packet holding several pins');
  assert.equal(P.decodePinSync(new DataView(P.encodePinSync([]))).length, 0);
  const v = new DataView(P.encodePinVote(70000, 9));
  assert.equal(v.byteLength, 7); assert.deepEqual(P.decodePinVote(v), { id: 70000, votes: 9 });
});
