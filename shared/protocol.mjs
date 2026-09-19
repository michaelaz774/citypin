// Binary wire protocol shared by server and client. Little-endian DataView, no allocations on hot paths.
// Positions are int16 at 0.25 m (±8 km), angles are uint8 (0..255 => 0..2π).

export const C2S = { STATE: 1, PING: 6, NAME: 10, WHO: 11, PLACE_PIN: 12, UPVOTE_PIN: 13 };
export const S2C = { WELCOME: 16, SNAPSHOT: 17, PONG: 20, NAME: 24, ROSTER: 27, PIN_ADD: 28, PIN_SYNC: 29, PIN_VOTE: 30 };
export const NAME_MAX = 12, DEFAULT_NAME = 'Resident';
export const FLAG = { FLYING: 1, MOVING: 4, AIRBORNE: 16 };
export const POS_SCALE = 4; // units per metre
export const PLAYER_REC = 11;

export const qPos = (m) => Math.max(-32768, Math.min(32767, Math.round(m * POS_SCALE)));
export const dqPos = (q) => q / POS_SCALE;
export const qAng = (r) => Math.round((((r % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * 256) & 255;
export const dqAng = (b) => (b / 256) * 2 * Math.PI;
export const qPitch = (r) => Math.round(((r + Math.PI / 2) / Math.PI) * 255) & 255;
export const dqPitch = (b) => (b / 255) * Math.PI - Math.PI / 2;

/** Player state record (11 B): id u16, x/y/z i16, yaw u8, pitch u8, flags u8. */
export function writePlayer(dv, o, id, x, y, z, yaw, pitch, flags) {
  dv.setUint16(o, id, true); dv.setInt16(o + 2, qPos(x), true); dv.setInt16(o + 4, qPos(y), true); dv.setInt16(o + 6, qPos(z), true);
  dv.setUint8(o + 8, qAng(yaw)); dv.setUint8(o + 9, qPitch(pitch)); dv.setUint8(o + 10, flags & 255);
  return o + PLAYER_REC;
}
export function readPlayer(dv, o, out) {
  out.id = dv.getUint16(o, true); out.x = dqPos(dv.getInt16(o + 2, true)); out.y = dqPos(dv.getInt16(o + 4, true)); out.z = dqPos(dv.getInt16(o + 6, true));
  out.yaw = dqAng(dv.getUint8(o + 8)); out.pitch = dqPitch(dv.getUint8(o + 9)); out.flags = dv.getUint8(o + 10);
  return o + PLAYER_REC;
}

// ---- client -> server ----
export function encodeState(x, y, z, yaw, pitch, flags) {
  const b = new ArrayBuffer(10), dv = new DataView(b);
  dv.setUint8(0, C2S.STATE); dv.setInt16(1, qPos(x), true); dv.setInt16(3, qPos(y), true); dv.setInt16(5, qPos(z), true);
  dv.setUint8(7, qAng(yaw)); dv.setUint8(8, qPitch(pitch)); dv.setUint8(9, flags & 255);
  return b;
}
export function decodeState(dv, out) {
  out.x = dqPos(dv.getInt16(1, true)); out.y = dqPos(dv.getInt16(3, true)); out.z = dqPos(dv.getInt16(5, true));
  out.yaw = dqAng(dv.getUint8(7)); out.pitch = dqPitch(dv.getUint8(8)); out.flags = dv.getUint8(9); return out;
}
/** Player names: trimmed, control characters stripped, at most NAME_MAX characters; empty falls back to DEFAULT_NAME. */
export function cleanName(s) {
  s = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s).slice(0, NAME_MAX); s = chars.join('').trim();
  return s || DEFAULT_NAME;
}
const enc = new TextEncoder(), dec = new TextDecoder();
/** NAME (c2s, ≤ 6+48 B): type, len u8, utf-8 bytes, token u32. The token is a random per-browser id that identifies a reconnecting browser. */
export function encodeName(name, token = 0) { const b = enc.encode(cleanName(name)).slice(0, 48); const out = new Uint8Array(6 + b.length); out[0] = C2S.NAME; out[1] = b.length; out.set(b, 2); new DataView(out.buffer).setUint32(2 + b.length, token >>> 0, true); return out.buffer; }
export function decodeName(dv) { const n = Math.max(0, Math.min(dv.getUint8(1), dv.byteLength - 2)); const name = cleanName(dec.decode(new Uint8Array(dv.buffer, dv.byteOffset + 2, n))); const token = dv.byteLength >= 6 + n ? dv.getUint32(2 + n, true) : 0; return { name, token }; }
/** WHO (3 B): ask for a player's name. */
export function encodeWho(id) { const b = new ArrayBuffer(3), dv = new DataView(b); dv.setUint8(0, C2S.WHO); dv.setUint16(1, id, true); return b; }
export function encodePing(t) { const b = new ArrayBuffer(5), dv = new DataView(b); dv.setUint8(0, C2S.PING); dv.setUint32(1, t >>> 0, true); return b; }

// ---- server -> client ----
/** WELCOME (3 B): type u8, myId u16. */
export function encodeWelcome(myId) { const b = new ArrayBuffer(3), dv = new DataView(b); dv.setUint8(0, S2C.WELCOME); dv.setUint16(1, myId, true); return b; }
export function decodeWelcome(dv) { return { myId: dv.getUint16(1, true) }; }
/** SNAPSHOT: type u8, nPlayers u16, then player records. Decoded into a caller-provided array to avoid garbage. */
export function decodeSnapshot(dv, players) {
  const np = dv.getUint16(1, true); let o = 3;
  players.length = 0;
  for (let i = 0; i < np; i++) { const p = {}; o = readPlayer(dv, o, p); players.push(p); }
}
/** NAME (s2c): type, id u16, len u8, utf-8 bytes. */
export function encodeNameOf(id, name) { const b = enc.encode(cleanName(name)).slice(0, 48); const out = new Uint8Array(4 + b.length); out[0] = S2C.NAME; out[1] = id & 255; out[2] = id >> 8; out[3] = b.length; out.set(b, 4); return out.buffer; }
export function decodeNameOf(dv, out) { out.id = dv.getUint16(1, true); const n = Math.min(dv.getUint8(3), dv.byteLength - 4); out.name = cleanName(dec.decode(new Uint8Array(dv.buffer, dv.byteOffset + 4, Math.max(0, n)))); return out; }
export function encodePong(t) { const b = new ArrayBuffer(5), dv = new DataView(b); dv.setUint8(0, S2C.PONG); dv.setUint32(1, t >>> 0, true); return b; }

/** ROSTER: every player's map position (6 B each: id u16, x i16, z i16 at 1 m), broadcast every few seconds for the minimap. */
export function encodeRoster(players) {
  const b = new ArrayBuffer(3 + players.length * 6), dv = new DataView(b);
  dv.setUint8(0, S2C.ROSTER); dv.setUint16(1, players.length, true);
  let o = 3; for (const p of players) { dv.setUint16(o, p.id, true); dv.setInt16(o + 2, Math.max(-32768, Math.min(32767, Math.round(p.x))), true); dv.setInt16(o + 4, Math.max(-32768, Math.min(32767, Math.round(p.z))), true); o += 6; }
  return b;
}
export function decodeRoster(dv, out) {
  const n = dv.getUint16(1, true); out.length = 0; let o = 3;
  for (let i = 0; i < n; i++) { out.push({ id: dv.getUint16(o, true), x: dv.getInt16(o + 2, true), z: dv.getInt16(o + 4, true) }); o += 6; }
  return out;
}

// ---- pins ----
// A pin is a resident's note about a spot in the city: category, position (local metres, x/z only — height is resolved at
// render time because the two world modes disagree on what "ground" is), a short note, a vote count and a timestamp.
export const NOTE_MAX = 48; // UTF-8 bytes, not characters
export const PIN_CATEGORIES = ['accessibility', 'safety', 'flooding', 'no shade', 'transit', 'green space', 'other'];
export const PIN_REC = 20; // id u32, cat u8, x f32, z f32, votes u16, t u32, len u8 — followed by `len` note bytes
/** Notes: control characters stripped, whitespace collapsed, cut to NOTE_MAX bytes on a character boundary. */
export function cleanNote(s) {
  s = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  let b = enc.encode(s); if (b.length <= NOTE_MAX) return s;
  b = b.slice(0, NOTE_MAX); return new TextDecoder().decode(b).replace(/�+$/, '').trim(); // never end mid code point (a fresh decoder: the shared one must not be left mid-sequence)
}
export const noteBytes = (s) => enc.encode(cleanNote(s));
export function writePin(dv, o, p, nb) {
  dv.setUint32(o, p.id >>> 0, true); dv.setUint8(o + 4, p.cat & 255); dv.setFloat32(o + 5, p.x, true); dv.setFloat32(o + 9, p.z, true);
  dv.setUint16(o + 13, Math.min(65535, p.votes | 0), true); dv.setUint32(o + 15, p.t >>> 0, true); dv.setUint8(o + 19, nb.length);
  new Uint8Array(dv.buffer, dv.byteOffset + o + PIN_REC, nb.length).set(nb); return o + PIN_REC + nb.length;
}
export function readPin(dv, o, out) {
  out.id = dv.getUint32(o, true); out.cat = dv.getUint8(o + 4); out.x = dv.getFloat32(o + 5, true); out.z = dv.getFloat32(o + 9, true);
  out.votes = dv.getUint16(o + 13, true); out.t = dv.getUint32(o + 15, true);
  const n = Math.max(0, Math.min(dv.getUint8(o + 19), dv.byteLength - o - PIN_REC));
  out.note = cleanNote(dec.decode(new Uint8Array(dv.buffer, dv.byteOffset + o + PIN_REC, n))); return o + PIN_REC + n;
}
/** PLACE_PIN (c2s, ≤ 11+48 B): type, category u8, x f32, z f32, len u8, utf-8 note. */
export function encodePlacePin(cat, x, z, note) {
  const nb = noteBytes(note); const out = new Uint8Array(11 + nb.length), dv = new DataView(out.buffer);
  dv.setUint8(0, C2S.PLACE_PIN); dv.setUint8(1, cat & 255); dv.setFloat32(2, x, true); dv.setFloat32(6, z, true); dv.setUint8(10, nb.length); out.set(nb, 11);
  return out.buffer;
}
export function decodePlacePin(dv, out) {
  out.cat = dv.getUint8(1); out.x = dv.getFloat32(2, true); out.z = dv.getFloat32(6, true);
  const n = Math.max(0, Math.min(dv.getUint8(10), dv.byteLength - 11));
  out.note = cleanNote(dec.decode(new Uint8Array(dv.buffer, dv.byteOffset + 11, n))); return out;
}
/** UPVOTE_PIN (c2s, 5 B): type, pin id u32. */
export function encodeUpvotePin(id) { const b = new ArrayBuffer(5), dv = new DataView(b); dv.setUint8(0, C2S.UPVOTE_PIN); dv.setUint32(1, id >>> 0, true); return b; }
export function decodeUpvotePin(dv) { return dv.getUint32(1, true); }
/** PIN_ADD (s2c): type, then one pin record. Broadcast to everyone when a pin is accepted. */
export function encodePinAdd(p) { const nb = noteBytes(p.note); const b = new ArrayBuffer(1 + PIN_REC + nb.length), dv = new DataView(b); dv.setUint8(0, S2C.PIN_ADD); writePin(dv, 1, p, nb); return b; }
export function decodePinAdd(dv, out = {}) { readPin(dv, 1, out); return out; }
/** PIN_SYNC (s2c): type, n u16, then n pin records. Sent on join so a newcomer sees every pin. */
export function encodePinSync(pins) {
  const parts = pins.map((p) => ({ p, nb: noteBytes(p.note) }));
  const b = new ArrayBuffer(3 + parts.reduce((a, q) => a + PIN_REC + q.nb.length, 0)), dv = new DataView(b);
  dv.setUint8(0, S2C.PIN_SYNC); dv.setUint16(1, parts.length, true); let o = 3;
  for (const { p, nb } of parts) o = writePin(dv, o, p, nb);
  return b;
}
export function decodePinSync(dv) { const n = dv.getUint16(1, true), out = []; let o = 3; for (let i = 0; i < n && o + PIN_REC <= dv.byteLength; i++) { const p = {}; o = readPin(dv, o, p); out.push(p); } return out; }
/** PIN_VOTE (s2c, 7 B): type, pin id u32, votes u16. */
export function encodePinVote(id, votes) { const b = new ArrayBuffer(7), dv = new DataView(b); dv.setUint8(0, S2C.PIN_VOTE); dv.setUint32(1, id >>> 0, true); dv.setUint16(5, Math.min(65535, votes | 0), true); return b; }
export function decodePinVote(dv, out = {}) { out.id = dv.getUint32(1, true); out.votes = dv.getUint16(5, true); return out; }
