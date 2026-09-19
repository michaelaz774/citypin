// Pure relay state: player slots, a spatial hash, and one snapshot packet per cell. No sockets here so it can be
// unit-tested and load-tested directly. Everyone shares one city; the relay only forwards where people are.
import { S2C, PLAYER_REC, DEFAULT_NAME, cleanName, cleanNote, writePlayer, encodeRoster, PIN_CATEGORIES } from '../shared/protocol.mjs';
import { PinStore } from './pinstore.mjs';

export const CELL = 100;                         // metres; everyone in a cell receives the same packet
export const RINGS = [                           // [radius m, max count, send every N ticks]
  [100, 30, 1], [250, 24, 2], [500, 20, 5],
];
export const ROSTER_TICKS = 30; // every 3 s everyone gets every player's map position (6 B each)
export const PLAYER_TIMEOUT_MS = 10000;
export const MAX_WALK_SPEED = 60;                        // m/s; fly-sprint is 40. Faster than this is a teleport...
export const JUMP_COOLDOWN_MS = 1500;                    // ...which the client does legitimately (R, map click), but not twice in a row
export const MAX_Y = 900;
export const PIN_COOLDOWN_MS = 5000;   // one pin per resident every 5 s
export const PIN_MAX_DIST = 150;       // metres: you report the spot you are standing at, not one across town
export const MAX_PINS = 5000;          // whole city
export const MAX_PINS_PER_PLAYER = 50;

export class World {
  constructor(bounds, store = new PinStore(null)) {
    this.bounds = bounds;
    this.maxPlayers = 4096;
    // dense SoA player storage indexed by slot; id == slot + 1 (0 reserved)
    this.alive = new Uint8Array(this.maxPlayers);
    this.px = new Float32Array(this.maxPlayers); this.py = new Float32Array(this.maxPlayers); this.pz = new Float32Array(this.maxPlayers);
    this.yaw = new Float32Array(this.maxPlayers); this.pitch = new Float32Array(this.maxPlayers); this.flags = new Uint8Array(this.maxPlayers);
    this.lastSeen = new Float64Array(this.maxPlayers);
    this.hasState = new Uint8Array(this.maxPlayers); // never show a player who hasn't reported a position yet
    this.lastJump = new Float64Array(this.maxPlayers); // last accepted teleport-speed move
    this.names = new Array(this.maxPlayers).fill(DEFAULT_NAME);
    this.token = new Uint32Array(this.maxPlayers);   // per-browser id from NAME: identifies a reconnecting browser
    this.freeSlots = []; for (let i = this.maxPlayers - 1; i >= 0; i--) this.freeSlots.push(i);
    this.lastPinAt = new Float64Array(this.maxPlayers);
    this.store = store;                               // pins live in the store so they outlive the process
    this.pinsByToken = new Map();                     // token (or -slot for a tokenless browser) -> pins reported
    this.maxPins = MAX_PINS; this.maxPinsPerPlayer = MAX_PINS_PER_PLAYER; // instance copies: adjustable in tests
    for (const p of this.store.pins.values()) { const k = p.voters.values().next().value; if (k !== undefined) this.pinsByToken.set(k, (this.pinsByToken.get(k) ?? 0) + 1); } // first voter is the reporter
    this.tick = 0;
    this.cells = new Map();          // cellKey -> Int32Array-ish list of slots (rebuilt per tick)
    this.stats = { droppedForBackpressure: 0, packetsBuilt: 0, playersOnline: 0 };
  }
  get playerCount() { let n = 0; for (let i = 0; i < this.maxPlayers; i++) n += this.alive[i]; return n; }

  join(now) {
    const slot = this.freeSlots.pop(); if (slot === undefined) return -1;
    this.alive[slot] = 1; this.px[slot] = 0; this.py[slot] = 0; this.pz[slot] = 0; this.flags[slot] = 0; this.lastSeen[slot] = now; this.hasState[slot] = 0; this.lastJump[slot] = -1e12; this.lastPinAt[slot] = -1e12; this.names[slot] = DEFAULT_NAME; this.token[slot] = 0;
    return slot + 1;
  }
  leave(id) {
    const s = id - 1; if (s < 0 || !this.alive[s]) return;
    this.alive[s] = 0; this.freeSlots.push(s);
  }
  inBounds(x, z) { const b = this.bounds; return x >= b.minX - 200 && x <= b.maxX + 200 && z >= b.minZ - 200 && z <= b.maxZ + 200; }
  setState(id, st, now) {
    const s = id - 1; if (!this.alive[s]) return false;
    if (!this.inBounds(st.x, st.z) || st.y < -50 || st.y > MAX_Y) return false;
    if (!this.plausibleMove(s, st.x, st.z, now, MAX_WALK_SPEED)) return false;
    this.px[s] = st.x; this.py[s] = st.y; this.pz[s] = st.z; this.yaw[s] = st.yaw; this.pitch[s] = st.pitch;
    this.flags[s] = st.flags & 255;
    this.lastSeen[s] = now; this.hasState[s] = 1; return true;
  }
  /** Name + session token. The token is kept per slot so a reconnecting browser stays recognisable. */
  setName(id, name, token = 0) {
    const s = id - 1; if (!this.alive[s]) return false; this.names[s] = cleanName(name);
    if (token) this.token[s] = token;
    return true;
  }
  nameOf(id) { const s = id - 1; return this.alive[s] ? this.names[s] : null; }
  /** A move faster than `max` m/s is a teleport: allowed once per JUMP_COOLDOWN_MS, otherwise the packet is dropped (client-side speed hacks). */
  plausibleMove(s, x, z, now, max) {
    if (!this.hasState[s]) return true;
    const dt = Math.max(0.02, (now - this.lastSeen[s]) / 1000);
    if (Math.hypot(x - this.px[s], z - this.pz[s]) / dt <= max) return true;
    if (now - this.lastJump[s] < JUMP_COOLDOWN_MS) return false;
    this.lastJump[s] = now; return true;
  }
  /** Expire silent players. Returns ids that timed out. */
  expire(now) {
    const gone = [];
    for (let s = 0; s < this.maxPlayers; s++) if (this.alive[s] && now - this.lastSeen[s] > PLAYER_TIMEOUT_MS) { gone.push(s + 1); this.leave(s + 1); }
    return gone;
  }

  cellKey(x, z) { return (Math.floor(x / CELL) + 32768) * 65536 + (Math.floor(z / CELL) + 32768); }
  rebuildCells() {
    for (const arr of this.cells.values()) arr.length = 0;
    for (let s = 0; s < this.maxPlayers; s++) {
      if (!this.alive[s] || !this.hasState[s]) continue;
      const k = this.cellKey(this.px[s], this.pz[s]);
      let arr = this.cells.get(k); if (!arr) { arr = []; this.cells.set(k, arr); }
      arr.push(s);
    }
  }
  /** Slots within `radius` m of (x,z), from the spatial hash. */
  gather(x, z, radius, out) {
    out.length = 0;
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL), r = Math.ceil(radius / CELL);
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      const arr = this.cells.get((cx + i + 32768) * 65536 + (cz + j + 32768)); if (!arr) continue;
      for (const s of arr) out.push(s);
    }
    return out;
  }

  /**
   * Build one snapshot packet for the cell containing (x,z). Ring selection keeps the N nearest to the cell centre
   * with a bounded insertion (no full sort). Rings 1 and 2 are only included on their tick multiples.
   */
  buildCellPacket(cx, cz) {
    const cand = this._cand ?? (this._cand = []);
    this.gather(cx, cz, RINGS[RINGS.length - 1][0], cand);
    const chosen = this._chosen ?? (this._chosen = []); chosen.length = 0;
    const d2s = this._d2 ?? (this._d2 = new Float32Array(this.maxPlayers));
    for (const s of cand) { const dx = this.px[s] - cx, dz = this.pz[s] - cz; d2s[s] = dx * dx + dz * dz; }
    let lo = 0;
    for (let r = 0; r < RINGS.length; r++) {
      const [rad, max, every] = RINGS[r]; const hi = rad * rad, lo2 = lo * lo;
      if (this.tick % every !== 0) { lo = rad; continue; }
      const best = this._best ?? (this._best = []); best.length = 0; // [d2, slot] kept ascending, max `max` long
      for (const s of cand) {
        const d2 = d2s[s]; if (d2 < lo2 || d2 >= hi) continue;
        if (best.length < max) { let i = best.length; best.push([d2, s]); while (i > 0 && best[i - 1][0] > d2) { best[i] = best[i - 1]; i--; } best[i] = [d2, s]; }
        else if (d2 < best[max - 1][0]) { let i = max - 1; while (i > 0 && best[i - 1][0] > d2) { best[i] = best[i - 1]; i--; } best[i] = [d2, s]; }
      }
      for (const b of best) chosen.push(b[1]);
      lo = rad;
    }
    const buf = new ArrayBuffer(3 + chosen.length * PLAYER_REC), dv = new DataView(buf);
    dv.setUint8(0, S2C.SNAPSHOT); dv.setUint16(1, chosen.length, true);
    let o = 3;
    for (const s of chosen) o = writePlayer(dv, o, s + 1, this.px[s], this.py[s], this.pz[s], this.yaw[s], this.pitch[s], this.flags[s]);
    this.stats.packetsBuilt++;
    return buf;
  }

  /** One tick: returns Map<slot, ArrayBuffer> of packets to send (one buffer shared per cell). */
  step() {
    this.tick++;
    this.rebuildCells();
    const out = new Map();
    for (const [key, arr] of this.cells) {
      if (!arr.length) continue;
      const cxi = Math.floor(key / 65536) - 32768, czi = (key % 65536) - 32768;
      const pkt = this.buildCellPacket((cxi + 0.5) * CELL, (czi + 0.5) * CELL);
      for (const s of arr) out.set(s, pkt);
    }
    this.stats.playersOnline = out.size;
    return out;
  }
  // ---- pins ----
  get pinCount() { return this.store.pins.size; }
  allPins() { return this.store.all(); }
  /** Who a vote belongs to: the browser token when there is one, otherwise the slot (negative, so it cannot collide). */
  voterKey(s) { return this.token[s] || -(s + 1); }
  /**
   * Accept a pin from player `id`, or return null. Every rule lives here: alive and positioned, off cooldown,
   * within PIN_MAX_DIST of where the player last reported standing, inside the map, a real category, under both caps.
   */
  placePin(id, p, now) {
    const s = id - 1; if (s < 0 || s >= this.maxPlayers || !this.alive[s] || !this.hasState[s]) return null;
    if (now - this.lastPinAt[s] < PIN_COOLDOWN_MS) return null;
    if (!Number.isInteger(p.cat) || p.cat < 0 || p.cat >= PIN_CATEGORIES.length) return null;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
    if (Math.hypot(p.x - this.px[s], p.z - this.pz[s]) > PIN_MAX_DIST) return null;
    if (!this.inBounds(p.x, p.z)) return null;
    if (this.store.pins.size >= this.maxPins) return null;
    const key = this.voterKey(s), mine = this.pinsByToken.get(key) ?? 0;
    if (mine >= this.maxPinsPerPlayer) return null;
    const pin = { id: this.store.nextId++, cat: p.cat, x: p.x, z: p.z, note: cleanNote(p.note), votes: 1, t: Math.floor(Date.now() / 1000), voters: new Set([key]) };
    this.store.pins.set(pin.id, pin); this.store.dirty = true;
    this.pinsByToken.set(key, mine + 1); this.lastPinAt[s] = now;
    return pin;
  }
  /** One vote per browser per pin, the reporter's own included. Returns the new count, or null if it did not count. */
  upvotePin(id, pinId) {
    const s = id - 1; if (s < 0 || s >= this.maxPlayers || !this.alive[s]) return null;
    const pin = this.store.pins.get(pinId); if (!pin) return null;
    const key = this.voterKey(s); if (pin.voters.has(key)) return null;
    pin.voters.add(key); pin.votes++; this.store.dirty = true;
    return pin.votes;
  }

  /** One shared buffer with every live player's position, for the minimap. */
  rosterPacket() {
    const list = [];
    for (let s = 0; s < this.maxPlayers; s++) if (this.alive[s] && this.hasState[s]) list.push({ id: s + 1, x: this.px[s], z: this.pz[s] });
    return encodeRoster(list);
  }
}
