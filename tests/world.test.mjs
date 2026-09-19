import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, RINGS, PLAYER_TIMEOUT_MS, MAX_Y, JUMP_COOLDOWN_MS } from '../server/world.mjs';
import { decodeSnapshot, decodeRoster, FLAG } from '../shared/protocol.mjs';

const bounds = { minX: -4000, maxX: 4000, minZ: -4000, maxZ: 4000 };
const mk = () => new World(bounds);
const st = (x, z, y = 0) => ({ x, y, z, yaw: 0, pitch: 0, flags: FLAG.MOVING });
const decode = (buf) => { const p = []; decodeSnapshot(new DataView(buf), p); return p; };

test('join/leave recycle slots and ids start at 1', () => {
  const w = mk(); const a = w.join(0), b = w.join(0);
  assert.equal(a, 1); assert.equal(b, 2); w.leave(a); assert.equal(w.join(0), 1);
});

test('state outside the map or absurd altitude is rejected', () => {
  const w = mk(); const id = w.join(0);
  assert.equal(w.setState(id, st(9000, 0), 1), false);
  assert.equal(w.setState(id, st(0, 0, MAX_Y + 1), 1), false);
  assert.equal(w.setState(id, st(10, 10), 1), true);
});

test('flags are relayed from the client untouched', () => {
  const w = mk(); const a = w.join(0);
  assert.ok(w.setState(a, { ...st(1, 1), flags: FLAG.FLYING | FLAG.AIRBORNE }, 0));
  assert.equal(w.flags[a - 1], FLAG.FLYING | FLAG.AIRBORNE);
  const p = decode(w.step().get(a - 1)).find((x) => x.id === a);
  assert.equal(p.flags, FLAG.FLYING | FLAG.AIRBORNE);
});

test('everyone in a cell gets the identical packet; self is included, far players are not', () => {
  const w = mk();
  const a = w.join(0), b = w.join(0), far = w.join(0);
  w.setState(a, st(10, 10), 0); w.setState(b, st(20, 20), 0); w.setState(far, st(3000, 3000), 0);
  const out = w.step();
  assert.strictEqual(out.get(a - 1), out.get(b - 1));
  const ids = decode(out.get(a - 1)).map((x) => x.id).sort();
  assert.deepEqual(ids, [a, b]);
  assert.deepEqual(decode(out.get(far - 1)).map((x) => x.id), [far]);
});

test('a 1000-player pile-up is capped to the ring budgets and never sorts the whole set', () => {
  const w = mk();
  for (let i = 0; i < 1000; i++) { const id = w.join(0); w.setState(id, st(Math.random() * 90, Math.random() * 90), 0); }
  const t0 = performance.now(); const out = w.step(); const dt = performance.now() - t0;
  const p = decode(out.get(0));
  assert.ok(p.length <= RINGS.reduce((n, r) => n + r[1], 0), `got ${p.length}`);
  assert.ok(dt < 30, `tick took ${dt.toFixed(1)} ms`);
});

test('outer rings only ship on their tick multiples', () => {
  const w = mk(); const a = w.join(0), mid = w.join(0), outer = w.join(0);
  w.setState(a, st(50, 50), 0); w.setState(mid, st(50 + 180, 50), 0); w.setState(outer, st(50 + 400, 50), 0);
  const seen = { mid: 0, outer: 0 };
  for (let t = 0; t < 10; t++) { const p = decode(w.step().get(a - 1)); if (p.some((x) => x.id === mid)) seen.mid++; if (p.some((x) => x.id === outer)) seen.outer++; }
  assert.equal(seen.mid, 5); assert.equal(seen.outer, 2);
});

test('a player who never sent a position is invisible to others', () => {
  const w = mk(); const a = w.join(0), ghost = w.join(0); w.setState(a, st(0, 0), 0);
  assert.deepEqual(decode(w.step().get(a - 1)).map((x) => x.id), [a]); assert.equal(w.step().has(ghost - 1), false);
});

test('roster lists every live player who has reported a position, however far apart', () => {
  const w = mk(); const a = w.join(0), b = w.join(0), ghost = w.join(0);
  w.setState(a, st(0, 0), 0); w.setState(b, st(3000, -3000), 0);
  const out = []; decodeRoster(new DataView(w.rosterPacket()), out);
  assert.deepEqual(out.map((p) => p.id).sort(), [a, b]); assert.equal(out.find((p) => p.id === b).x, 3000); void ghost;
});

test('silent players expire', () => {
  const w = mk(); const a = w.join(0); w.setState(a, st(0, 0), 0);
  assert.deepEqual(w.expire(PLAYER_TIMEOUT_MS + 1), [a]); assert.equal(w.playerCount, 0);
});

test('names default to Resident, can be set while alive, and the token is kept for the slot', () => {
  const w = mk(); const a = w.join(0), b = w.join(0);
  assert.equal(w.nameOf(a), 'Resident'); assert.ok(w.setName(b, ' West End  ')); assert.equal(w.nameOf(b), 'West End');
  assert.ok(w.setName(a, 'Aubrey', 777)); assert.equal(w.token[a - 1], 777);
  assert.ok(w.setName(a, 'Aubrey')); assert.equal(w.token[a - 1], 777, 'a nameless re-send keeps the token');
  assert.equal(w.setName(999, 'Nobody'), false, 'unknown id');
  w.leave(b); assert.equal(w.nameOf(b), null);
  assert.equal(w.join(0), b); assert.equal(w.nameOf(b), 'Resident', 'a recycled slot starts fresh'); assert.equal(w.token[b - 1], 0);
});

test('movement sanity: walking faster than 60 m/s is a teleport, allowed once per 1.5 s, then dropped', () => {
  const w = mk(); const a = w.join(0);
  assert.ok(w.setState(a, st(0, 0), 1000));
  assert.ok(w.setState(a, st(4, 0), 1100), '40 m/s: fine');
  assert.ok(w.setState(a, st(500, 0), 1200), 'first teleport accepted (R key, map click)');
  assert.equal(w.setState(a, st(1000, 0), 1300), false, 'second teleport inside the cooldown: dropped');
  assert.equal(w.px[a - 1], 500, 'position unchanged by the dropped packet');
  assert.ok(w.setState(a, st(504, 0), 1400), 'normal movement still flows');
  assert.ok(w.setState(a, st(1500, 0), 1200 + JUMP_COOLDOWN_MS + 1), 'a teleport after the cooldown is fine');
});
