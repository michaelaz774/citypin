// Pure 2-D geometry for lateral collision (walker footprint circle vs. building footprint polygons).
// Plain JS so it can be unit-tested from node and imported by the client's TS colliders alike.

/** Even-odd point-in-polygon; `p` is an open ring of [x, z] pairs. */
export function pointInRing(x, z, p) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i][0], zi = p[i][1], xj = p[j][0], zj = p[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Closest point on the ring's boundary to (x,z): { x, z, d2, i } where i is the edge index (p[i] -> p[i+1]). */
export function nearestOnRing(x, z, p) {
  let bx = 0, bz = 0, bd = Infinity, bi = 0;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const ax = p[j][0], az = p[j][1], vx = p[i][0] - ax, vz = p[i][1] - az, L = vx * vx + vz * vz;
    let t = L > 0 ? ((x - ax) * vx + (z - az) * vz) / L : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + vx * t, qz = az + vz * t, dx = x - qx, dz = z - qz, d2 = dx * dx + dz * dz;
    if (d2 < bd) { bd = d2; bx = qx; bz = qz; bi = j; }
  }
  return { x: bx, z: bz, d2: bd, i: bi };
}

/** Unit normal of edge i (p[i] -> p[i+1]) pointing out of the ring, whichever winding the ring has. */
export function outwardNormal(p, i) {
  const [ax, az] = p[i], [bx, bz] = p[(i + 1) % p.length];
  const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
  let nx = dz / L, nz = -dx / L;
  if (pointInRing((ax + bx) / 2 + nx * 0.01, (az + bz) / 2 + nz * 0.01, p)) { nx = -nx; nz = -nz; }
  return { nx, nz };
}

/**
 * Push a circle (centre x,z radius r) out of ring `p`. (fx,fz) is where the circle came from this frame: a centre that
 * tunnelled inside a thin building is sent back out through the edge it crossed rather than the nearest one.
 * Returns the corrected centre and the unit push normal, or null when the circle doesn't overlap the ring.
 */
export function pushCircleOutOfRing(x, z, r, p, fx = x, fz = z) {
  if (p.length < 3) return null;
  if (!pointInRing(x, z, p)) {
    const q = nearestOnRing(x, z, p), d = Math.sqrt(q.d2);
    if (d >= r) return null;
    let nx, nz;
    if (d > 1e-6) { nx = (x - q.x) / d; nz = (z - q.z) / d; } else ({ nx, nz } = outwardNormal(p, q.i));
    return { x: q.x + nx * r, z: q.z + nz * r, nx, nz };
  }
  if ((fx !== x || fz !== z) && !pointInRing(fx, fz, p)) {
    // crossed an edge this frame: slide back to that edge's plane, keeping motion along it
    const q = nearestOnRing(fx, fz, p), { nx, nz } = outwardNormal(p, q.i);
    const depth = (x - q.x) * nx + (z - q.z) * nz; // <= 0 inside
    return { x: x + nx * (r - depth), z: z + nz * (r - depth), nx, nz };
  }
  const q = nearestOnRing(x, z, p);
  let nx = q.x - x, nz = q.z - z;
  const L = Math.hypot(nx, nz);
  if (L > 1e-6) { nx /= L; nz /= L; } else ({ nx, nz } = outwardNormal(p, q.i));
  return { x: q.x + nx * r, z: q.z + nz * r, nx, nz };
}

/**
 * Resolve a circle against many rings at once (iterated so corners between two buildings settle).
 * `rings` is any iterable of rings. Returns { x, z, nx, nz } of the final position and the last wall normal, or null.
 */
export function pushCircleOutOfRings(x, z, r, rings, fx = x, fz = z, passes = 3) {
  let hit = null;
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const p of rings) {
      const h = pushCircleOutOfRing(x, z, r, p, fx, fz);
      if (!h) continue;
      x = h.x; z = h.z; hit = h; moved = true;
    }
    if (!moved) break;
  }
  return hit ? { x, z, nx: hit.nx, nz: hit.nz } : null;
}
