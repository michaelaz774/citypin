#!/usr/bin/env node
// Pulls downtown Toronto map data from the Overpass API and writes
// public/data/toronto.json in local metric coordinates centred on the CN Tower.
//
//   node scripts/fetch-osm.mjs            # uses scripts/.cache/ when present
//   node scripts/fetch-osm.mjs --refresh  # ignore the cache and re-fetch
//
// Node >= 20, ESM, no dependencies.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE_DIR = join(__dirname, '.cache');
const OUT_FILE = join(ROOT, 'public', 'data', 'toronto.json');

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const BBOX = { south: 43.612, west: -79.430, north: 43.690, east: -79.330 }; // downtown + ~2 km buffer
const ORIGIN = { lat: 43.6426, lon: -79.3871 };

const REFRESH = process.argv.includes('--refresh');
const MAX_SPLIT_DEPTH = 2; // full -> 2x2 -> 4x4

const ROAD_TYPES = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential',
  'unclassified', 'living_street', 'service', 'pedestrian',
];

const LANDMARKS = [
  { n: 'CN Tower', match: ['cn tower'] },
  { n: 'Rogers Centre', match: ['rogers centre'] },
  { n: 'Scotiabank Arena', match: ['scotiabank arena'] },
  { n: 'Union Station', match: ['union station'] },
  { n: 'Toronto City Hall', match: ['toronto city hall', 'city hall'], exclude: ['old city hall'] },
  { n: 'Old City Hall', match: ['old city hall'] },
  { n: 'Royal Ontario Museum', match: ['royal ontario museum'] },
  { n: 'Eaton Centre', match: ['eaton centre'] },
  { n: 'First Canadian Place', match: ['first canadian place'] },
  { n: 'TD Centre', match: ['td centre', 'toronto-dominion centre', 'toronto dominion centre', 'toronto dominion bank tower', 'toronto-dominion bank tower', 'td bank tower'] },
  { n: 'Roy Thomson Hall', match: ['roy thomson hall'] },
  { n: 'St. Lawrence Market', match: ['st. lawrence market', 'st lawrence market'] },
  { n: 'Art Gallery of Ontario', match: ['art gallery of ontario'] },
  { n: 'Casa Loma', match: ['casa loma'] },
  { n: 'Harbourfront Centre', match: ['harbourfront centre'] },
  { n: 'Nathan Phillips Square', match: ['nathan phillips square'] },
];

// ---------------------------------------------------------------- projection

const COS_LAT0 = Math.cos((ORIGIN.lat * Math.PI) / 180);
const round1 = (v) => Math.round(v * 10) / 10;

function project(lat, lon) {
  return [
    round1((lon - ORIGIN.lon) * COS_LAT0 * 111320),
    round1(-(lat - ORIGIN.lat) * 110574),
  ];
}

// ---------------------------------------------------------------- overpass

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function bboxStr(b) {
  return `${b.south},${b.west},${b.north},${b.east}`;
}

function cachePath(query) {
  const hash = createHash('sha256').update(query).digest('hex').slice(0, 20);
  return join(CACHE_DIR, `${hash}.json`);
}

async function readCache(query) {
  if (REFRESH) return null;
  try {
    const raw = await readFile(cachePath(query), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

class OverpassError extends Error {
  constructor(message, { retryable = false, tooBig = false } = {}) {
    super(message);
    this.retryable = retryable;
    this.tooBig = tooBig;
  }
}

async function overpassOnce(endpoint, query) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'User-Agent': 'citypin/0.1 (map data fetch; +https://github.com/michaelaz774)',
    },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(220_000),
  });
  const text = await res.text();
  if (res.status === 429 || res.status === 504 || res.status === 502 || res.status === 503) {
    // 504 from the front proxy usually means the server is busy, not that
    // the query is too big; retry (and fall back) before splitting the bbox.
    throw new OverpassError(`HTTP ${res.status} from ${endpoint}`, { retryable: true });
  }
  if (!res.ok) {
    throw new OverpassError(`HTTP ${res.status} from ${endpoint}: ${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OverpassError(`Non-JSON response from ${endpoint}: ${text.slice(0, 300)}`, { retryable: true });
  }
  if (json.remark && /error/i.test(json.remark)) {
    const tooBig = /timed out|out of memory|too many|limit/i.test(json.remark);
    throw new OverpassError(`Overpass remark: ${json.remark}`, { retryable: !tooBig, tooBig });
  }
  return json;
}

// Fetch one query with caching, endpoint fallback and backoff on 429/504.
async function overpass(query, label) {
  const cached = await readCache(query);
  if (cached) {
    console.log(`  [cache] ${label} (${cached.elements.length} elements)`);
    return cached;
  }
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    let anyRetryable = false;
    for (const endpoint of ENDPOINTS) {
      const t0 = Date.now();
      try {
        console.log(`  [fetch] ${label} via ${new URL(endpoint).host} (attempt ${attempt + 1})`);
        const json = await overpassOnce(endpoint, query);
        console.log(`  [ok]    ${label}: ${json.elements.length} elements in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        await mkdir(CACHE_DIR, { recursive: true });
        await writeFile(cachePath(query), JSON.stringify(json));
        return json;
      } catch (err) {
        lastErr = err;
        console.log(`  [err]   ${label}: ${err.message}`);
        if (err instanceof OverpassError && err.tooBig) throw err; // let caller split
        if (!(err instanceof OverpassError) || err.retryable) anyRetryable = true;
        // non-retryable (e.g. 400/406): fall through to the next endpoint
      }
    }
    if (!anyRetryable) throw lastErr;
    const wait = 3000 * 2 ** attempt;
    console.log(`  [wait]  ${Math.round(wait / 1000)}s before retry`);
    await sleep(wait);
  }
  // Persistent gateway timeouts: let the caller try a smaller bbox.
  if (lastErr instanceof OverpassError && /HTTP 504/.test(lastErr.message)) lastErr.tooBig = true;
  throw lastErr;
}

function splitBbox(b, n) {
  const cells = [];
  const dLat = (b.north - b.south) / n;
  const dLon = (b.east - b.west) / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      cells.push({
        south: +(b.south + i * dLat).toFixed(6),
        north: +(b.south + (i + 1) * dLat).toFixed(6),
        west: +(b.west + j * dLon).toFixed(6),
        east: +(b.west + (j + 1) * dLon).toFixed(6),
      });
    }
  }
  return cells;
}

// Fetch a query over a bbox; on timeout / too-big split into a 2x2 grid and
// merge, deduping by element type+id.
async function fetchBoxed(buildQuery, bbox, label, depth = 0) {
  try {
    const json = await overpass(buildQuery(bbox), label);
    return json.elements;
  } catch (err) {
    if (!(err instanceof OverpassError && err.tooBig) || depth >= MAX_SPLIT_DEPTH) throw err;
    console.log(`  [split] ${label}: splitting bbox into 2x2`);
    const seen = new Map();
    const cells = splitBbox(bbox, 2);
    for (let i = 0; i < cells.length; i++) {
      const els = await fetchBoxed(buildQuery, cells[i], `${label} cell ${i + 1}/${cells.length}`, depth + 1);
      for (const el of els) seen.set(`${el.type}/${el.id}`, el);
    }
    return [...seen.values()];
  }
}

// ---------------------------------------------------------------- queries

const roadRegex = `^(${ROAD_TYPES.join('|')})$`;
const AEROWAY_TYPES = ['runway', 'taxiway', 'apron', 'helipad', 'aerodrome'];
const aerowayRegex = `^(${AEROWAY_TYPES.join('|')})$`;

const QUERIES = {
  buildings: (b) => `[out:json][timeout:180];
(
  way["building"](${bboxStr(b)});
  relation["building"]["type"="multipolygon"](${bboxStr(b)});
);
out geom;`,
  roads: (b) => `[out:json][timeout:180];
(
  way["highway"~"${roadRegex}"](${bboxStr(b)});
);
out geom;`,
  parks: (b) => `[out:json][timeout:180];
(
  way["leisure"~"^(park|garden|pitch)$"](${bboxStr(b)});
  way["landuse"~"^(grass|recreation_ground)$"](${bboxStr(b)});
  relation["leisure"~"^(park|garden|pitch)$"](${bboxStr(b)});
  relation["landuse"~"^(grass|recreation_ground)$"](${bboxStr(b)});
);
out geom;`,
  water: (b) => `[out:json][timeout:180];
(
  way["natural"="water"](${bboxStr(b)});
  way["waterway"="riverbank"](${bboxStr(b)});
  way["water"](${bboxStr(b)});
  relation["natural"="water"](${bboxStr(b)});
  relation["waterway"="riverbank"](${bboxStr(b)});
  relation["water"](${bboxStr(b)});
  way["natural"="coastline"](${bboxStr(b)});
);
out geom;`,
  rail: (b) => `[out:json][timeout:180];
(
  way["railway"~"^(rail|subway)$"]["tunnel"!="yes"](${bboxStr(b)});
);
out geom;`,
  aeroway: (b) => `[out:json][timeout:180];
(
  way["aeroway"~"${aerowayRegex}"](${bboxStr(b)});
  relation["aeroway"~"${aerowayRegex}"](${bboxStr(b)});
);
out geom;`,
};

// ---------------------------------------------------------------- geometry

// Turn a way's geometry ([{lat,lon}]) into projected [x,z] points.
function projectWay(geometry) {
  const pts = [];
  for (const g of geometry || []) {
    if (g && typeof g.lat === 'number' && typeof g.lon === 'number') pts.push(project(g.lat, g.lon));
  }
  return pts;
}

// Assemble closed rings from a set of way geometries (lat/lon), joining ways
// end-to-end. Returns rings as arrays of {lat,lon} (closed: first == last).
function assembleRings(ways) {
  const segs = ways.map((g) => g.slice()).filter((g) => g.length >= 2);
  const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;
  const rings = [];
  while (segs.length) {
    let ring = segs.pop();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 10000) {
      const tail = key(ring[ring.length - 1]);
      let found = -1;
      let reverse = false;
      for (let i = 0; i < segs.length; i++) {
        if (key(segs[i][0]) === tail) { found = i; break; }
        if (key(segs[i][segs[i].length - 1]) === tail) { found = i; reverse = true; break; }
      }
      if (found < 0) break; // unclosed; keep as-is
      let next = segs.splice(found, 1)[0];
      if (reverse) next = next.slice().reverse();
      ring = ring.concat(next.slice(1));
    }
    rings.push(ring);
  }
  return rings;
}

// Outer rings of a multipolygon relation, projected. Members with role
// "outer" (or empty role, which some old data uses).
function relationOuterRings(rel) {
  const ways = [];
  for (const m of rel.members || []) {
    if (m.type !== 'way' || !m.geometry) continue;
    if (m.role === 'outer' || m.role === '') ways.push(m.geometry);
  }
  return assembleRings(ways).map(projectWay);
}

function signedArea2(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i];
    const b = p[(i + 1) % p.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s; // 2x signed area
}

// Clean a ring: drop closing duplicate, drop consecutive duplicates, reject
// degenerate polygons, enforce positive signed area.
function cleanRing(pts) {
  if (!pts || pts.length < 3) return null;
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  const distinct = new Set(out.map((p) => `${p[0]},${p[1]}`));
  if (distinct.size < 3) return null;
  const a2 = signedArea2(out);
  if (Math.abs(a2) / 2 < 4) return null;
  if (a2 < 0) out.reverse();
  return out;
}

function centroid(p) {
  // Area-weighted polygon centroid.
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, z0] = p[i];
    const [x1, z1] = p[(i + 1) % p.length];
    const cross = x0 * z1 - x1 * z0;
    a += cross;
    cx += (x0 + x1) * cross;
    cz += (z0 + z1) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const n = p.length;
    return [round1(p.reduce((s, q) => s + q[0], 0) / n), round1(p.reduce((s, q) => s + q[1], 0) / n)];
  }
  return [round1(cx / (3 * a)), round1(cz / (3 * a))];
}

// Drop features that sprawl far outside the bbox (e.g. a lake relation).
const [BX0, BZ0] = project(BBOX.north, BBOX.west);
const [BX1, BZ1] = project(BBOX.south, BBOX.east);
const SPRAWL = 5000; // metres beyond the bbox before we give up on a feature
function tooSprawling(pts) {
  for (const [x, z] of pts) {
    if (x < BX0 - SPRAWL || x > BX1 + SPRAWL || z < BZ0 - SPRAWL || z > BZ1 + SPRAWL) return true;
  }
  return false;
}

// ---------------------------------------------------------------- tags

function parseHeight(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().toLowerCase().replace(',', '.');
  if (!s) return null;
  // 10'6" style
  const ftIn = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*"?)?$/);
  if (ftIn) {
    const ft = parseFloat(ftIn[1]) + (ftIn[2] ? parseFloat(ftIn[2]) / 12 : 0);
    return ft * 0.3048;
  }
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet|foot|')?$/);
  if (!m) {
    // e.g. "553 ft;..." or "12 m (approx)" – take the leading number
    const lead = s.match(/^(-?\d+(?:\.\d+)?)/);
    if (!lead) return null;
    const v = parseFloat(lead[1]);
    return /ft|feet|'/.test(s) ? v * 0.3048 : v;
  }
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = m[2] || 'm';
  return unit.startsWith('f') || unit === "'" ? v * 0.3048 : v;
}

function parseLevels(raw) {
  if (raw == null) return null;
  const m = String(raw).replace(',', '.').match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

const DEFAULT_HEIGHT = {
  house: 6, detached: 6, garage: 6, shed: 6,
  residential: 12, apartments: 12,
  commercial: 15, retail: 15, office: 15,
  industrial: 9, warehouse: 9,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function buildingHeight(tags) {
  const h = parseHeight(tags.height);
  // Ignore bogus tiny heights (e.g. the ROM is tagged height=0.1) and fall
  // through to levels / type defaults instead.
  if (h != null && Number.isFinite(h) && h >= 2) return { h: clamp(round1(h), 3, 600), src: 'explicit' };
  const lv = parseLevels(tags['building:levels']);
  if (lv != null) return { h: clamp(round1(lv * 3.3 + 1), 3, 600), src: 'levels' };
  const k = String(tags.building || '').toLowerCase();
  return { h: clamp(DEFAULT_HEIGHT[k] ?? 10, 3, 600), src: 'default' };
}

function layerBelowGround(tags) {
  if (tags.tunnel === 'yes') return true;
  if (tags.layer != null) {
    const l = parseInt(tags.layer, 10);
    if (Number.isFinite(l) && l < 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------- builders

const stats = {
  explicitHeight: 0, levelsHeight: 0, defaultHeight: 0,
  dropped: { degenerate: 0, sprawl: 0 },
  coastFromRelations: [],
};

function buildBuildings(elements) {
  const out = [];
  const seen = new Set();
  for (const el of elements) {
    const tags = el.tags || {};
    if (!tags.building || tags.building === 'no') continue;
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);

    let rings;
    if (el.type === 'way') rings = [projectWay(el.geometry)];
    else if (el.type === 'relation') rings = relationOuterRings(el);
    else continue;

    const { h, src } = buildingHeight(tags);
    const mh = parseHeight(tags.min_height);
    let any = false;
    for (const r of rings) {
      const p = cleanRing(r);
      if (!p) { stats.dropped.degenerate++; continue; }
      if (tooSprawling(p)) { stats.dropped.sprawl++; continue; }
      const b = { p, h };
      if (tags.name) b.n = tags.name;
      if (tags.building !== 'yes') b.k = tags.building;
      if (mh != null && Number.isFinite(mh) && mh > 0) b.mh = round1(mh);
      out.push(b);
      any = true;
    }
    if (any) {
      if (src === 'explicit') stats.explicitHeight++;
      else if (src === 'levels') stats.levelsHeight++;
      else stats.defaultHeight++;
    }
  }
  return out;
}

function buildRoads(elements) {
  const out = [];
  for (const el of elements) {
    if (el.type !== 'way') continue;
    const tags = el.tags || {};
    if (!ROAD_TYPES.includes(tags.highway)) continue;
    const p = projectWay(el.geometry);
    if (p.length < 2) continue;
    const r = { p, k: tags.highway };
    if (tags.name) r.n = tags.name;
    out.push(r);
  }
  return out;
}

function buildPolygons(elements, accept) {
  const out = [];
  for (const el of elements) {
    const tags = el.tags || {};
    if (!accept(tags)) continue;
    let rings;
    if (el.type === 'way') rings = [projectWay(el.geometry)];
    else if (el.type === 'relation') rings = relationOuterRings(el);
    else continue;
    for (const r of rings) {
      const p = cleanRing(r);
      if (!p) { stats.dropped.degenerate++; continue; }
      if (tooSprawling(p)) { stats.dropped.sprawl++; continue; }
      out.push({ p });
    }
  }
  return out;
}

function buildPolylines(elements, accept) {
  const out = [];
  for (const el of elements) {
    if (el.type !== 'way') continue;
    const tags = el.tags || {};
    if (!accept(tags)) continue;
    const p = projectWay(el.geometry);
    if (p.length < 2) continue;
    out.push({ p });
  }
  return out;
}

// Airport features (Billy Bishop): runway/taxiway centrelines as polylines, aprons/aerodrome/helipads as
// polygons. A closed runway or taxiway way tagged area=yes is the paved surface, not a centreline.
function buildAeroway(elements) {
  const out = [];
  const seen = new Set();
  for (const el of elements) {
    const tags = el.tags || {};
    const k = tags.aeroway;
    if (!AEROWAY_TYPES.includes(k)) continue;
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = tags.ref || tags.name;
    const push = (p, closed) => { const f = { p, k, closed }; if (n) f.n = n; out.push(f); };
    if (el.type === 'way') {
      const p = projectWay(el.geometry);
      if (p.length < 2) continue;
      const isLoop = p.length >= 4 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1];
      const asArea = (k === 'runway' || k === 'taxiway') ? isLoop && tags.area === 'yes' : isLoop;
      if (!asArea) { push(p, false); continue; }
      const ring = cleanRing(p);
      if (!ring) { stats.dropped.degenerate++; continue; }
      if (tooSprawling(ring)) { stats.dropped.sprawl++; continue; }
      push(ring, true);
    } else if (el.type === 'relation') {
      for (const r of relationOuterRings(el)) {
        const ring = cleanRing(r);
        if (!ring) { stats.dropped.degenerate++; continue; }
        if (tooSprawling(ring)) { stats.dropped.sprawl++; continue; }
        push(ring, true);
      }
    }
  }
  return out;
}

// Clip a projected polyline to the bbox plus a margin, splitting it into runs.
const COAST_MARGIN = 1500;
function clipPolyline(pts, margin) {
  const runs = [];
  let run = [];
  for (const p of pts) {
    const inside = p[0] >= BX0 - margin && p[0] <= BX1 + margin && p[1] >= BZ0 - margin && p[1] <= BZ1 + margin;
    if (inside) run.push(p);
    else if (run.length) { runs.push(run); run = []; }
  }
  if (run.length) runs.push(run);
  return runs.filter((r) => r.length >= 2);
}

// Coastline: natural=coastline ways, plus the outer edge of any water
// multipolygon too large to keep as a polygon (Lake Ontario is mapped as a
// natural=water relation, not with natural=coastline, around Toronto).
function buildCoast(elements) {
  const out = [];
  for (const el of elements) {
    const tags = el.tags || {};
    if (el.type === 'way' && isCoast(tags)) {
      const p = projectWay(el.geometry);
      if (p.length >= 2) out.push({ p });
      continue;
    }
    if (el.type !== 'relation' || !isWater(tags)) continue;
    const rings = relationOuterRings(el);
    if (!rings.some((r) => tooSprawling(r))) continue;
    stats.coastFromRelations.push(tags.name || `relation/${el.id}`);
    for (const m of el.members || []) {
      if (m.type !== 'way' || !m.geometry || (m.role !== 'outer' && m.role !== '')) continue;
      for (const run of clipPolyline(projectWay(m.geometry), COAST_MARGIN)) out.push({ p: run });
    }
  }
  return out;
}

function isPark(t) {
  return ['park', 'garden', 'pitch'].includes(t.leisure) || ['grass', 'recreation_ground'].includes(t.landuse);
}
function isWater(t) {
  return t.natural === 'water' || t.waterway === 'riverbank' || (t.water != null && t.natural !== 'coastline');
}
function isCoast(t) {
  return t.natural === 'coastline';
}
function isRail(t) {
  return ['rail', 'subway'].includes(t.railway) && !layerBelowGround(t);
}

function findLandmarks(buildings) {
  const landmarks = [];
  const found = [];
  for (const lm of LANDMARKS) {
    let best = null;
    let bestScore = -Infinity;
    for (const b of buildings) {
      if (!b.n) continue;
      const name = b.n.toLowerCase();
      if (lm.exclude && lm.exclude.some((x) => name.includes(x))) continue;
      const hit = lm.match.some((m) => name.includes(m));
      if (!hit) continue;
      const exact = lm.match.some((m) => name === m) ? 1e12 : 0;
      const score = exact + Math.abs(signedArea2(b.p)) / 2;
      if (score > bestScore) { bestScore = score; best = b; }
    }
    if (!best) continue;
    if (lm.n === 'CN Tower' && best.h < 553) best.h = 553;
    best.l = true;
    const [x, z] = centroid(best.p);
    landmarks.push({ n: lm.n, x, z, h: best.h });
    found.push(`${lm.n} ("${best.n}")`);
  }
  if (!landmarks.some((l) => l.n === 'CN Tower')) {
    landmarks.push({ n: 'CN Tower', x: 0, z: 0, h: 553 });
    found.push('CN Tower (hardcoded at origin)');
  }
  return { landmarks, found };
}

// ---------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  console.log(`Fetching downtown Toronto (${bboxStr(BBOX)})`);

  const raw = {};
  for (const [name, build] of Object.entries(QUERIES)) {
    console.log(`\n${name}:`);
    raw[name] = await fetchBoxed(build, BBOX, name);
  }

  console.log('\nBuilding output...');
  const buildings = buildBuildings(raw.buildings);
  const roads = buildRoads(raw.roads);
  const parks = buildPolygons(raw.parks, isPark);
  const water = buildPolygons(raw.water, isWater);
  const coast = buildCoast(raw.water);
  const rail = buildPolylines(raw.rail, isRail);
  const aeroway = buildAeroway(raw.aeroway);
  const { landmarks, found } = findLandmarks(buildings);

  const data = {
    origin: ORIGIN,
    bbox: BBOX,
    buildings,
    roads,
    parks,
    water,
    coast,
    rail,
    landmarks,
    aeroway,
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(data));
  const size = (await stat(OUT_FILE)).size;

  const tallest = buildings
    .slice()
    .sort((a, b) => b.h - a.h)
    .slice(0, 10)
    .map((b) => `${b.h} m  ${b.n || '(unnamed)'}${b.k ? ` [${b.k}]` : ''}`);

  console.log(`\nWrote ${OUT_FILE}`);
  console.log(`  size: ${(size / 1024 / 1024).toFixed(2)} MB (${size.toLocaleString()} bytes)`);
  console.log(`  buildings: ${buildings.length}  (explicit height: ${stats.explicitHeight}, estimated: ${stats.levelsHeight + stats.defaultHeight} = ${stats.levelsHeight} from levels + ${stats.defaultHeight} by type default)`);
  console.log(`  roads: ${roads.length}`);
  console.log(`  parks: ${parks.length}`);
  console.log(`  water: ${water.length}`);
  console.log(`  coast: ${coast.length}${stats.coastFromRelations.length ? ` (outer edge of: ${stats.coastFromRelations.join(', ')})` : ''}`);
  console.log(`  rail: ${rail.length}`);
  console.log(`  landmarks: ${landmarks.length}`);
  const byKind = {}; for (const a of aeroway) byKind[a.k] = (byKind[a.k] || 0) + 1;
  console.log(`  aeroway: ${aeroway.length} (${Object.entries(byKind).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'})`);
  const runways = aeroway.filter((a) => a.k === 'runway' && a.n).map((a) => a.n);
  if (runways.length) console.log(`  runways: ${[...new Set(runways)].join(', ')}`);
  console.log(`  dropped: ${stats.dropped.degenerate} degenerate, ${stats.dropped.sprawl} sprawling`);
  console.log('\nTallest buildings:');
  for (const t of tallest) console.log(`  ${t}`);
  console.log('\nLandmarks:');
  for (const f of found) console.log(`  ${f}`);
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exit(1);
});
