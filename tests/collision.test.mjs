import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pointInRing, nearestOnRing, outwardNormal, pushCircleOutOfRing, pushCircleOutOfRings } from '../shared/collide.mjs';

const sq = [[0, 0], [10, 0], [10, 10], [0, 10]]; // 10 m square, either winding
const sqCW = [...sq].reverse();
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('pointInRing / nearestOnRing basics', () => {
  assert.equal(pointInRing(5, 5, sq), true); assert.equal(pointInRing(-1, 5, sq), false);
  const q = nearestOnRing(-3, 4, sq); near(q.x, 0); near(q.z, 4); near(q.d2, 9);
});

test('outwardNormal points out of the ring regardless of winding', () => {
  for (const r of [sq, sqCW]) for (let i = 0; i < 4; i++) {
    const [ax, az] = r[i], [bx, bz] = r[(i + 1) % 4]; const { nx, nz } = outwardNormal(r, i);
    assert.equal(pointInRing((ax + bx) / 2 + nx * 0.1, (az + bz) / 2 + nz * 0.1, r), false);
  }
});

test('circle outside and clear of the ring is untouched', () => {
  assert.equal(pushCircleOutOfRing(-2, 5, 0.35, sq), null);
});

test('circle overlapping an edge from outside is pushed back to the edge', () => {
  const h = pushCircleOutOfRing(-0.1, 5, 0.35, sq);
  near(h.x, -0.35); near(h.z, 5); near(h.nx, -1); near(h.nz, 0);
});

test('centre that crossed a wall goes back out through the edge it crossed (not the nearest one)', () => {
  // came from the left (x=-0.3) and ended deep inside near the right edge: the from-point wins over the nearest edge
  const h = pushCircleOutOfRing(9.2, 5, 0.35, sq, -0.3, 5);
  near(h.x, -0.35); near(h.z, 5); near(h.nx, -1);
});

test('centre inside with no from-point leaves through the nearest edge', () => {
  const h = pushCircleOutOfRing(9.6, 5, 0.35, sq);
  near(h.x, 10.35); near(h.nx, 1);
});

test('sliding: a diagonal move into a wall keeps its tangential component', () => {
  const from = { x: -0.5, z: 5 }, to = { x: 0.1, z: 5.7 }; // moving +x (into the wall) and +z (along it)
  const h = pushCircleOutOfRing(to.x, to.z, 0.35, sq, from.x, from.z);
  near(h.x, -0.35); near(h.z, 5.7); // z motion preserved
});

test('two buildings forming a corner settle without jitter in a few passes', () => {
  const other = [[-10, 10.2], [10, 10.2], [10, 20], [-10, 20]]; // 0.2 m alley above sq
  const h = pushCircleOutOfRings(5, 10.1, 0.35, [sq, other]);
  assert.ok(h); // pushed out of both, or at least out of one and reported
  assert.ok(!pointInRing(h.x, h.z, sq) || !pointInRing(h.x, h.z, other));
  const wide = [[-10, 12], [10, 12], [10, 20], [-10, 20]]; // 2 m alley: fits, ends up touching neither
  const g = pushCircleOutOfRings(5, 10.1, 0.35, [sq, wide]);
  near(g.x, 5); near(g.z, 10.35);
  assert.equal(pushCircleOutOfRing(g.x, g.z, 0.35, wide), null);
});

test('degenerate rings never throw', () => {
  assert.equal(pushCircleOutOfRing(0, 0, 1, []), null);
  assert.equal(pushCircleOutOfRing(0, 0, 1, [[0, 0], [1, 1]]), null);
  assert.ok(pushCircleOutOfRing(0, 0, 1, [[0, 0], [0, 0], [0, 0]]) !== undefined); // zero-area triangle
});
