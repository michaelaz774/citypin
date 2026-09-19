import type { Building, Road } from './geo';
import type { Ground, WallHit, Vec3Like } from './player';
import { pointInRing, pushCircleOutOfRings } from '../shared/collide.mjs';

export { pointInRing };

export interface Hit { h: number; b: Building | null }

/** Spatial hash of building footprints. topAt() = height of the tallest building covering (x,z). */
export class CityCollider implements Ground {
  cell = 40;
  grid = new Map<number, number[]>();
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  constructor(public buildings: Building[]) {
    buildings.forEach((b, i) => {
      let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (const [x, z] of b.p) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
      this.bounds.push({ minX, maxX, minZ, maxZ });
      for (let cx = Math.floor(minX / this.cell); cx <= Math.floor(maxX / this.cell); cx++)
        for (let cz = Math.floor(minZ / this.cell); cz <= Math.floor(maxZ / this.cell); cz++) {
          const k = this.key(cx, cz);
          let arr = this.grid.get(k);
          if (!arr) { arr = []; this.grid.set(k, arr); }
          arr.push(i);
        }
    });
  }
  private key(cx: number, cz: number) { return (cx + 32768) * 65536 + (cz + 32768); }
  /** Ground is flat y=0; a building whose underside (min_height) starts above fromY is a bridge we're under, not a floor. */
  topAt(x: number, z: number, fromY?: number): number { return this.hitAt(x, z, fromY).h; }
  hitAt(x: number, z: number, fromY = Infinity): Hit {
    const arr = this.grid.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    let h = 0, best: Building | null = null;
    if (!arr) return { h, b: best };
    for (const i of arr) {
      const bb = this.bounds[i];
      if (x < bb.minX || x > bb.maxX || z < bb.minZ || z > bb.maxZ) continue;
      const b = this.buildings[i];
      if (b.h > h && (b.mh ?? 0) <= fromY && pointInRing(x, z, b.p)) { h = b.h; best = b; }
    }
    return { h, b: best };
  }

  private candidates: number[][][] = [];
  /** Exact footprint-edge push-out. A building blocks when its roof is above the step and its underside below the head. */
  resolveWalls(from: Vec3Like, pos: Vec3Like, radius: number, height: number, step: number): WallHit | null {
    const rings = this.candidates; rings.length = 0;
    const floor = pos.y + step, head = pos.y + height;
    const c0x = Math.floor((pos.x - radius) / this.cell), c1x = Math.floor((pos.x + radius) / this.cell);
    const c0z = Math.floor((pos.z - radius) / this.cell), c1z = Math.floor((pos.z + radius) / this.cell);
    for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
      const arr = this.grid.get(this.key(cx, cz)); if (!arr) continue;
      for (const i of arr) {
        const bb = this.bounds[i], b = this.buildings[i];
        if (b.h <= floor || (b.mh ?? 0) >= head) continue;
        if (pos.x + radius < bb.minX || pos.x - radius > bb.maxX || pos.z + radius < bb.minZ || pos.z - radius > bb.maxZ) continue;
        if (!rings.includes(b.p)) rings.push(b.p);
      }
    }
    if (!rings.length) return null;
    const h = pushCircleOutOfRings(pos.x, pos.z, radius, rings, from.x, from.z);
    if (!h) return null;
    pos.x = h.x; pos.z = h.z;
    return { nx: h.nx, nz: h.nz };
  }
}

/** Spatial hash of road segments for "what street am I on". */
export class RoadIndex {
  cell = 100;
  grid = new Map<number, [number, number][]>(); // [roadIdx, segIdx]
  constructor(public roads: Road[]) {
    roads.forEach((r, ri) => {
      for (let s = 0; s < r.p.length - 1; s++) {
        const [ax, az] = r.p[s], [bx, bz] = r.p[s + 1];
        const c0x = Math.floor(Math.min(ax, bx) / this.cell), c1x = Math.floor(Math.max(ax, bx) / this.cell);
        const c0z = Math.floor(Math.min(az, bz) / this.cell), c1z = Math.floor(Math.max(az, bz) / this.cell);
        for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
          const k = (cx + 32768) * 65536 + (cz + 32768);
          let arr = this.grid.get(k); if (!arr) { arr = []; this.grid.set(k, arr); }
          arr.push([ri, s]);
        }
      }
    });
  }
  nearest(x: number, z: number, maxDist = 60): { road: Road; dist: number } | null {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    let best: Road | null = null, bd = maxDist * maxDist;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const arr = this.grid.get((cx + dx + 32768) * 65536 + (cz + dz + 32768));
      if (!arr) continue;
      for (const [ri, s] of arr) {
        const r = this.roads[ri];
        if (!r.n) continue;
        const [ax, az] = r.p[s], [bx, bz] = r.p[s + 1];
        const vx = bx - ax, vz = bz - az, L = vx * vx + vz * vz;
        let t = L > 0 ? ((x - ax) * vx + (z - az) * vz) / L : 0; t = Math.max(0, Math.min(1, t));
        const px = ax + vx * t - x, pz = az + vz * t - z, d = px * px + pz * pz;
        if (d < bd) { bd = d; best = r; }
      }
    }
    return best ? { road: best, dist: Math.sqrt(bd) } : null;
  }
}
