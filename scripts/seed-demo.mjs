// Seed a relay with demo pins across downtown Toronto, through the same websocket protocol a browser uses: each pin comes
// from its own "resident" standing at the spot (so the relay's distance, cooldown and per-browser rules hold), and a
// handful of other residents agree with it. Idempotent: spots that already have a pin are skipped.
//   node scripts/seed-demo.mjs [wss://relay] [https://allowed-origin]
import WebSocket from 'ws';
import * as P from '../shared/protocol.mjs';

const URL = process.argv[2] ?? 'ws://localhost:8790', ORIGIN = process.argv[3] ?? 'https://citypin.pages.dev';
const O = { lat: 43.6426, lon: -79.3871 }, COS = Math.cos((O.lat * Math.PI) / 180);
const loc = (lat, lon) => ({ x: (lon - O.lon) * COS * 111320, z: -(lat - O.lat) * 110574 });

// [lat, lon, category, note (<= 48 bytes), extra agree votes]
const PINS = [
  [43.6473, -79.4033, 1, 'Streetcar stop: no island, step into traffic', 9],
  [43.6529, -79.3980, 0, 'Light changes before the walker gets across', 7],
  [43.6561, -79.3802, 4, 'Bus bay blocked by delivery vans every morning', 4],
  [43.6453, -79.3806, 0, 'PATH ramp closed, the detour is 400 m', 11],
  [43.6420, -79.3855, 1, 'Underpass unlit after 9 pm, people avoid it', 8],
  [43.6389, -79.3817, 3, 'No shade or bench while waiting for the 509', 5],
  [43.6487, -79.3817, 0, 'Curb cut missing on the NE corner', 6],
  [43.6547, -79.4021, 1, 'Cars use the pedestrian street as a shortcut', 3],
  [43.6470, -79.4140, 5, 'Park path floods, mud for a week after rain', 4],
  [43.6667, -79.4038, 4, 'Subway entrance is stairs only, no elevator', 10],
  [43.6600, -79.3900, 5, 'Queens Park paths flood, no benches under trees', 2],
  [43.6395, -79.3935, 2, 'Underpass floods every storm, sidewalk gone', 7],
  [43.6570, -79.3745, 1, 'Crossing feels unsafe at night, no lighting', 5],
  [43.6487, -79.3716, 3, 'Market queue stands in full sun all July', 3],
  [43.6503, -79.3596, 0, 'Cobblestones impossible with a chair or stroller', 6],
  [43.6525, -79.3839, 5, 'Nowhere to sit in the shade on the square', 4],
  [43.6647, -79.3855, 4, 'Bus stop has no shelter, wind tunnel in winter', 2],
  [43.6432, -79.3948, 2, 'Catch basin blocked, huge puddle at the crossing', 5],
  [43.6655, -79.3809, 1, 'Crosswalk faded, drivers do not stop', 3],
  [43.6580, -79.3790, 6, 'Bike racks full daily, bikes chained to fences', 1],
  [43.6619, -79.3952, 0, 'Circle path has no curb cut at the north gate', 2],
  [43.6540, -79.3860, 3, 'Hospital row: no shade at any of the stops', 3],
];
// ~60 more along real corridors, deterministic (seeded) so a re-run skips what exists
let seed = 20260919; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const NOTES = {
  0: ['No curb cut at this corner', 'Sidewalk too narrow for a wheelchair', 'Ramp blocked by patio furniture', 'No tactile strip at the crossing', 'Elevator out of service for weeks', 'Steps only into the station'],
  1: ['Crossing feels unsafe after dark', 'Cars run the red here every day', 'No crosswalk for 300 m', 'Bike lane ends into traffic', 'Sightline blocked by parked trucks', 'Speeding on this stretch, no calming'],
  2: ['Puddle covers the crossing after rain', 'Storm drain always blocked with leaves', 'Underpass floods in every storm', 'Sidewalk ices over, no drainage'],
  3: ['Stop has no shelter and no shade', 'Bench in full sun all afternoon', 'Long wait here, nothing to sit on', 'No trees for two blocks'],
  4: ['Stop blocked by parked cars', 'Bus bunching, 20 minute gaps', 'Streetcar stop too narrow for a stroller', 'No shelter at this stop'],
  5: ['Park has no benches in the shade', 'Path is mud for a week after rain', 'No lighting on the park path', 'The only bench is broken'],
  6: ['Bike racks always full', 'Construction fence blocks the sidewalk', 'Bins overflow every weekend', 'Wayfinding sign points the wrong way'],
};
const CORRIDORS = [ // Bloor, Queen, King, Dundas, College, Queens Quay; Yonge, Spadina, Bathurst, Jarvis, Parliament, University
  ['lat', 43.6672, -79.4200, -79.3700], ['lat', 43.6485, -79.4200, -79.3650], ['lat', 43.6452, -79.4100, -79.3700], ['lat', 43.6545, -79.4200, -79.3600], ['lat', 43.6612, -79.4100, -79.3700], ['lat', 43.6390, -79.4000, -79.3700],
  ['lon', -79.3835, 43.6450, 43.6850], ['lon', -79.3995, 43.6400, 43.6800], ['lon', -79.4110, 43.6400, 43.6800], ['lon', -79.3740, 43.6500, 43.6700], ['lon', -79.3650, 43.6500, 43.6700], ['lon', -79.3890, 43.6450, 43.6750],
];
for (let i = 0; i < 60; i++) {
  const c = CORRIDORS[i % CORRIDORS.length]; const t = rnd(); const j = () => (rnd() - 0.5) * 0.0006;
  const lat = c[0] === 'lat' ? c[1] + j() : c[2] + (c[3] - c[2]) * t + j(), lon = c[0] === 'lat' ? c[2] + (c[3] - c[2]) * t + j() : c[1] + j();
  const cat = [0, 1, 1, 2, 3, 4, 4, 5, 6][Math.floor(rnd() * 9)]; const pool = NOTES[cat]; const note = pool[Math.floor(rnd() * pool.length)];
  const extra = Math.max(0, Math.floor(rnd() * rnd() * 12));
  PINS.push([+lat.toFixed(5), +lon.toFixed(5), cat, note, extra]);
}

const NAMES = ['Amina', 'Ben', 'Chloe', 'Dev', 'Elena', 'Farah', 'Grace', 'Hiro', 'Ivy', 'Jamal', 'Kai', 'Lena', 'Malik', 'Noor', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tariq', 'Uma', 'Vik', 'Wen', 'Yara', 'Zoe'];
const token = () => (Math.random() * 0xfffffffe + 1) >>> 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const open = (name) => new Promise((res, rej) => {
  const ws = new WebSocket(URL, { origin: ORIGIN }); ws.binaryType = 'arraybuffer'; ws.q = [];
  ws.on('message', (d) => ws.q.push(new DataView(d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))));
  ws.on('error', (e) => rej(e)); ws.on('open', () => { ws.send(P.encodeName(name, token())); res(ws); });
});
const next = (ws, type, ms = 4000) => new Promise((res, rej) => { const t0 = Date.now(); const poll = () => { const i = ws.q.findIndex((v) => v.getUint8(0) === type); if (i >= 0) return res(ws.q.splice(i, 1)[0]); if (Date.now() - t0 > ms) return rej(new Error('timeout waiting for ' + type)); setTimeout(poll, 20); }; poll(); });

// what is already there, so a re-run never duplicates a spot
const probe = await open('Probe'); await next(probe, P.S2C.WELCOME);
const syncDv = await next(probe, P.S2C.PIN_SYNC, 5000).catch(() => null); const existing = syncDv ? P.decodePinSync(syncDv) : []; probe.close();
const has = (x, z) => existing.some((p) => Math.hypot(p.x - x, p.z - z) < 3);

let placed = 0, votes = 0, skipped = 0, failed = 0;
const one = async ([lat, lon, cat, note, extra], i) => {
  const { x, z } = loc(lat, lon);
  if (has(x, z)) { skipped++; return; }
  const socks = [];
  try {
    const ws = await open(NAMES[i % NAMES.length]); socks.push(ws);
    await next(ws, P.S2C.WELCOME); ws.q.length = 0;
    ws.send(P.encodeState(x, 0, z, 0, 0, 0)); await sleep(150);
    ws.send(P.encodePlacePin(cat, x, z, note));
    let id = null;
    for (let k = 0; k < 30 && id === null; k++) { const dv = await next(ws, P.S2C.PIN_ADD, 4000).catch(() => null); if (!dv) break; const p = P.decodePinAdd(dv); if (Math.abs(p.x - x) < 0.5 && Math.abs(p.z - z) < 0.5) id = p.id; }
    if (id === null) { failed++; console.log('not accepted:', note); return; }
    placed++;
    for (let j = 0; j < extra; j++) { // voters one at a time: the relay caps sockets per address
      const v = await open(NAMES[(i * 7 + j + 3) % NAMES.length]); socks.push(v);
      await next(v, P.S2C.WELCOME); v.send(P.encodeState(x + 1, 0, z + 1, 0, 0, 0)); await sleep(80); v.send(P.encodeUpvotePin(id)); votes++; await sleep(60);
    }
    await sleep(200);
  } catch (e) { failed++; console.log('failed:', note, '-', e.message); }
  finally { for (const s of socks) try { s.close(); } catch {} }
};
const BATCH = 4; // a few residents at a time keeps well under the relay's per-address socket cap
for (let i = 0; i < PINS.length; i += BATCH) await Promise.all(PINS.slice(i, i + BATCH).map((p, k) => one(p, i + k)));
console.log(JSON.stringify({ relay: URL, existing: existing.length, skipped, placed, votes, failed }));
process.exit(0);
