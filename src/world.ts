import * as THREE from 'three';
import type { Building, CityData, Poly, Road } from './geo';
import { pointInRing } from './collision';

/** Minimal indexed geometry accumulator with per-vertex colors. */
class GeoBuilder {
  pos: number[] = []; nor: number[] = []; col: number[] = []; idx: number[] = [];
  get n() { return this.pos.length / 3; }
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color) {
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.col.push(c.r, c.g, c.b);
    return this.n - 1;
  }
  tri(a: number, b: number, c: number) { this.idx.push(a, b, c); }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const TILE = 400;
const tileKey = (x: number, z: number) => `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;

function ringCentroid(p: number[][]) {
  let x = 0, z = 0; for (const q of p) { x += q[0]; z += q[1]; } return [x / p.length, z / p.length];
}

function triangulate(p: number[][]): number[][] {
  const pts = p.map(([x, z]) => new THREE.Vector2(x, z));
  try { return THREE.ShapeUtils.triangulateShape(pts, []); } catch { return []; }
}

/** Add a horizontal polygon at height y with an upward normal. */
function addFlatPoly(gb: GeoBuilder, p: number[][], y: number, c: THREE.Color) {
  const tris = triangulate(p); if (!tris.length) return;
  const base = gb.n;
  for (const [x, z] of p) gb.vert(x, y, z, 0, 1, 0, c);
  for (const [a, b, cc] of tris) {
    // ensure upward-facing winding
    const ax = p[a][0], az = p[a][1], bx = p[b][0], bz = p[b][1], cx = p[cc][0], cz = p[cc][1];
    const ny = (bx - ax) * (cz - az) - (bz - az) * (cx - ax); // y component of (b-a)x(c-a) is -(...) ; sign check below
    if (-ny > 0) gb.tri(base + a, base + b, base + cc); else gb.tri(base + a, base + cc, base + b);
  }
}

const HUE_BY_KIND: Record<string, [number, number, number]> = {
  apartments: [0.08, 0.10, 0.62], residential: [0.09, 0.12, 0.66], house: [0.07, 0.18, 0.60], detached: [0.07, 0.18, 0.60],
  commercial: [0.58, 0.06, 0.62], office: [0.58, 0.08, 0.60], retail: [0.06, 0.14, 0.70], industrial: [0.0, 0.0, 0.5],
  warehouse: [0.0, 0.0, 0.45], hotel: [0.55, 0.10, 0.66], university: [0.05, 0.22, 0.58], school: [0.05, 0.22, 0.58],
  church: [0.05, 0.18, 0.55], cathedral: [0.05, 0.18, 0.55], hospital: [0.0, 0.0, 0.8], parking: [0.0, 0.0, 0.5],
  garage: [0.0, 0.0, 0.5], stadium: [0.0, 0.0, 0.55], train_station: [0.06, 0.20, 0.55], public: [0.06, 0.12, 0.6],
};

function buildingColor(b: Building, rnd: number): THREE.Color {
  const c = new THREE.Color();
  if (b.l) { c.setHSL(0.55, 0.35, 0.72); return c; }
  const k = b.k ?? '';
  const base = HUE_BY_KIND[k] ?? (b.h > 80 ? [0.56, 0.12, 0.66] : b.h > 30 ? [0.07, 0.06, 0.6] : [0.08, 0.12, 0.62]);
  c.setHSL(base[0] + (rnd - 0.5) * 0.03, base[1], base[2] + (rnd - 0.5) * 0.14);
  if (b.h > 120) { c.setHSL(0.56 + (rnd - 0.5) * 0.05, 0.18, 0.62 + rnd * 0.15); }
  return c;
}

function addBuilding(gb: GeoBuilder, b: Building, rnd: number) {
  const p = b.p; const n = p.length; if (n < 3) return;
  const top = b.h, bot = b.mh ?? 0;
  const c = buildingColor(b, rnd);
  const cDark = c.clone().multiplyScalar(0.55);
  // Walls. Outward normal for a ring with positive signed area in (x,z): (dz, -dx). Verify once and flip if wrong.
  let flip = false;
  {
    const [ax, az] = p[0], [bx, bz] = p[1 % n];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
    const nx = dz / L, nz = -dx / L, mx = (ax + bx) / 2 + nx * 0.05, mz = (az + bz) / 2 + nz * 0.05;
    if (pointInRing(mx, mz, p)) flip = true;
  }
  for (let i = 0; i < n; i++) {
    const [ax, az] = p[i], [bx, bz] = p[(i + 1) % n];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
    let nx = dz / L, nz = -dx / L; if (flip) { nx = -nx; nz = -nz; }
    // subtle per-wall shading so adjacent faces read distinctly
    const shade = 0.85 + 0.15 * Math.abs(nx);
    const cw = c.clone().multiplyScalar(shade), cwd = cDark.clone().multiplyScalar(shade);
    const v0 = gb.vert(ax, bot, az, nx, 0, nz, cwd), v1 = gb.vert(bx, bot, bz, nx, 0, nz, cwd);
    const v2 = gb.vert(bx, top, bz, nx, 0, nz, cw), v3 = gb.vert(ax, top, az, nx, 0, nz, cw);
    if (flip) { gb.tri(v0, v2, v1); gb.tri(v0, v3, v2); } else { gb.tri(v0, v1, v2); gb.tri(v0, v2, v3); }
  }
  addFlatPoly(gb, p, top, c.clone().multiplyScalar(0.9));
}

function roadWidth(k: string) {
  switch (k) {
    case 'motorway': case 'motorway_link': return 16;
    case 'trunk': case 'trunk_link': return 14;
    case 'primary': case 'primary_link': return 13;
    case 'secondary': case 'secondary_link': return 11;
    case 'tertiary': case 'tertiary_link': return 9;
    case 'residential': case 'unclassified': return 7;
    case 'living_street': case 'pedestrian': return 5;
    case 'service': return 4;
    default: return 6;
  }
}

function addRibbon(gb: GeoBuilder, p: number[][], w: number, y: number, c: THREE.Color) {
  const hw = w / 2;
  for (let i = 0; i < p.length - 1; i++) {
    const [ax, az] = p[i], [bx, bz] = p[i + 1];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz); if (L < 0.01) continue;
    const nx = (dz / L) * hw, nz = (-dx / L) * hw;
    const v0 = gb.vert(ax + nx, y, az + nz, 0, 1, 0, c), v1 = gb.vert(bx + nx, y, bz + nz, 0, 1, 0, c);
    const v2 = gb.vert(bx - nx, y, bz - nz, 0, 1, 0, c), v3 = gb.vert(ax - nx, y, az - nz, 0, 1, 0, c);
    // winding: with normal +y, front face is CCW seen from above (x right, z down => visually CW in math terms). Use both tests via cross.
    const cross = (bx + nx - (ax + nx)) * (bz - nz - (az + nz)) - (bz + nz - (az + nz)) * (bx - nx - (ax + nx));
    if (-cross > 0) { gb.tri(v0, v1, v2); gb.tri(v0, v2, v3); } else { gb.tri(v0, v2, v1); gb.tri(v0, v3, v2); }
    // round joint cap at interior vertices
    if (i > 0) addDisc(gb, ax, y, az, hw, c);
  }
}
function addDisc(gb: GeoBuilder, x: number, y: number, z: number, r: number, c: THREE.Color, seg = 8) {
  const ctr = gb.vert(x, y, z, 0, 1, 0, c);
  const ring: number[] = [];
  for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; ring.push(gb.vert(x + Math.cos(a) * r, y, z + Math.sin(a) * r, 0, 1, 0, c)); }
  for (let i = 0; i < seg; i++) gb.tri(ctr, ring[(i + 1) % seg], ring[i]);
}

export interface WorldMeshes { group: THREE.Group; tiles: Map<string, THREE.Object3D[]> }

export function buildWorld(data: CityData, scene: THREE.Scene): WorldMeshes {
  const group = new THREE.Group();
  const tiles = new Map<string, THREE.Object3D[]>();
  const bMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const flatMat = new THREE.MeshLambertMaterial({ vertexColors: true });

  // Buildings per tile
  const byTile = new Map<string, GeoBuilder>();
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const b of data.buildings) {
    if (b.n && /cn tower/i.test(b.n)) continue; // rendered procedurally
    const [cx, cz] = ringCentroid(b.p); const k = tileKey(cx, cz);
    let gb = byTile.get(k); if (!gb) { gb = new GeoBuilder(); byTile.set(k, gb); }
    addBuilding(gb, b, rnd());
  }
  for (const [k, gb] of byTile) {
    const m = new THREE.Mesh(gb.build(), bMat); m.castShadow = true; m.receiveShadow = true;
    group.add(m); tiles.set(k, [m]);
  }

  // Roads / rail per tile (by first point)
  const roadTiles = new Map<string, GeoBuilder>();
  const cRoad = new THREE.Color(0x35363b), cMinor = new THREE.Color(0x45464b), cPed = new THREE.Color(0x8d8a80);
  const cLine = new THREE.Color(0xd8b64a), cRail = new THREE.Color(0x6b6560);
  const getRT = (x: number, z: number) => { const k = tileKey(x, z); let g = roadTiles.get(k); if (!g) { g = new GeoBuilder(); roadTiles.set(k, g); } return g; };
  for (const r of data.roads as Road[]) {
    const gb = getRT(r.p[0][0], r.p[0][1]);
    const w = roadWidth(r.k);
    const c = r.k === 'pedestrian' || r.k === 'living_street' ? cPed : w >= 9 ? cRoad : cMinor;
    addRibbon(gb, r.p, w, 0.05, c);
    if (w >= 9) addRibbon(gb, r.p, 0.35, 0.07, cLine);
  }
  for (const r of data.rail as Poly[]) addRibbon(getRT(r.p[0][0], r.p[0][1]), r.p, 3.2, 0.04, cRail);
  for (const [k, gb] of roadTiles) {
    const m = new THREE.Mesh(gb.build(), flatMat); m.receiveShadow = true; group.add(m);
    (tiles.get(k) ?? tiles.set(k, []).get(k)!).push(m);
  }

  // Parks & water
  const gPark = new GeoBuilder(), gWater = new GeoBuilder();
  const cPark = new THREE.Color(0x5f9a4c), cWater = new THREE.Color(0x3a7fb5);
  for (const p of data.parks) addFlatPoly(gPark, p.p, 0.03, cPark);
  for (const p of data.water) addFlatPoly(gWater, p.p, 0.02, cWater);
  const parkMesh = new THREE.Mesh(gPark.build(), flatMat); parkMesh.receiveShadow = true; group.add(parkMesh);
  const waterMesh = new THREE.Mesh(gWater.build(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  group.add(waterMesh);

  // Ground + lake beyond the south edge of the data
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000), new THREE.MeshLambertMaterial({ color: 0xb7b2a6 }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; group.add(ground);
  const lakeRing = buildLakePolygon(data.coast);
  if (lakeRing) { const gl = new GeoBuilder(); addFlatPoly(gl, lakeRing, 0.015, cWater); group.add(new THREE.Mesh(gl.build(), flatMat)); }

  group.add(buildCNTower());
  scene.add(group);
  return { group, tiles };
}

/**
 * Lake Ontario isn't a polygon in the data (it's a 700-way relation); we get the shoreline as polylines.
 * Chain them by endpoint, take the longest chain (west edge -> Don River), and close it off far to the south.
 */
function buildLakePolygon(coast: Poly[]): number[][] | null {
  const pieces = coast.map((c) => c.p.slice()).filter((p) => p.length >= 2);
  if (!pieces.length) return null;
  const near = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 8;
  const chains: number[][][] = [];
  while (pieces.length) {
    const chain = pieces.shift()!;
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pieces.length; i++) {
        const q = pieces[i];
        if (near(chain[chain.length - 1], q[0])) { chain.push(...q.slice(1)); pieces.splice(i, 1); grew = true; break; }
        if (near(chain[chain.length - 1], q[q.length - 1])) { chain.push(...q.slice(0, -1).reverse()); pieces.splice(i, 1); grew = true; break; }
        if (near(chain[0], q[q.length - 1])) { chain.unshift(...q.slice(0, -1)); pieces.splice(i, 1); grew = true; break; }
        if (near(chain[0], q[0])) { chain.unshift(...q.slice(1).reverse()); pieces.splice(i, 1); grew = true; break; }
      }
    }
    chains.push(chain);
  }
  chains.sort((a, b) => b.length - a.length);
  let ring = chains[0];
  if (ring[0][0] > ring[ring.length - 1][0]) ring = ring.slice().reverse(); // west -> east
  const FAR = 8000, S = 8000;
  const first = ring[0], last = ring[ring.length - 1];
  return [...ring, [FAR, last[1]], [FAR, S], [-FAR, S], [-FAR, first[1]]];
}

/** Procedural CN Tower at the origin: hexagonal shaft, SkyPod, main pod, antenna. */
export function buildCNTower(): THREE.Group {
  const g = new THREE.Group();
  const concrete = new THREE.MeshLambertMaterial({ color: 0xd9d6cf });
  const glass = new THREE.MeshLambertMaterial({ color: 0x5e7f9e });
  const steel = new THREE.MeshLambertMaterial({ color: 0xb8bcc2 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, y: number) => { const m = new THREE.Mesh(geo, mat); m.position.y = y; m.castShadow = true; g.add(m); return m; };
  // base "Y" shaped legs approximated by a wide tapered hex, then the shaft
  add(new THREE.CylinderGeometry(9, 22, 40, 6), concrete, 20);
  add(new THREE.CylinderGeometry(6.5, 9, 300, 6), concrete, 40 + 150);
  // main pod (335–355 m): restaurant/observation levels
  add(new THREE.CylinderGeometry(22, 16, 6, 24), concrete, 335 + 3);
  add(new THREE.CylinderGeometry(24, 22, 8, 24), glass, 341 + 4);
  add(new THREE.CylinderGeometry(20, 24, 6, 24), concrete, 349 + 3);
  add(new THREE.CylinderGeometry(8, 8, 2, 24), concrete, 355 + 1);
  // shaft to SkyPod
  add(new THREE.CylinderGeometry(4.5, 6.5, 90, 6), concrete, 356 + 45);
  // SkyPod (447 m)
  add(new THREE.CylinderGeometry(9, 7, 5, 16), glass, 444 + 2.5);
  add(new THREE.CylinderGeometry(6, 9, 3, 16), concrete, 449 + 1.5);
  // antenna to 553
  add(new THREE.CylinderGeometry(1.2, 3.5, 60, 8), steel, 451 + 30);
  add(new THREE.CylinderGeometry(0.4, 1.2, 42, 8), steel, 511 + 21);
  // pod deck the player can stand on is handled by the collider (footprint h=553); add a visible platform at the top.
  return g;
}
