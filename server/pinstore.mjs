// Durable pin storage: one plain JSON file, read at startup and rewritten atomically whenever pins change.
// Kept out of World so the placement rules stay unit-testable without touching disk (a null path = memory only).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class PinStore {
  constructor(filePath = null) {
    this.path = filePath || null;
    this.pins = new Map();   // id -> { id, cat, x, z, note, votes, t, voters:Set }
    this.nextId = 1;
    this.dirty = false;
  }
  get size() { return this.pins.size; }
  all() { return [...this.pins.values()]; }
  /** Read the file. A missing file is an empty store; a corrupt one is logged and also starts empty — never a crash. */
  load(log = console.log) {
    if (!this.path) return this;
    let raw;
    try { raw = readFileSync(this.path, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') log(`[pins] cannot read ${this.path}: ${e.message}`); return this; }
    let list = null;
    try { const j = JSON.parse(raw); if (Array.isArray(j?.pins)) list = j.pins; } catch { list = null; }
    if (!list) { log(`[pins] ignoring unreadable contents of ${this.path}`); return this; }
    for (const p of list) {
      const id = p?.id | 0; if (id < 1 || this.pins.has(id)) continue;
      this.pins.set(id, { id, cat: p.cat | 0, x: +p.x || 0, z: +p.z || 0, note: String(p.note ?? ''),
        votes: Math.max(1, p.votes | 0), t: p.t >>> 0, voters: new Set(Array.isArray(p.voters) ? p.voters : []) });
    }
    this.nextId = Math.max(1, ...[...this.pins.keys()].map((k) => k + 1));
    return this;
  }
  /** Write via `<path>.tmp` + rename so a half-written file is never left behind. Creates the parent directory. */
  save() {
    if (!this.path) { this.dirty = false; return false; }
    const json = JSON.stringify({ pins: this.all().map((p) => ({ ...p, voters: [...p.voters] })) });
    try {
      mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = this.path + '.tmp';
      writeFileSync(tmp, json); renameSync(tmp, this.path);
    } catch (e) { console.log(`[pins] cannot write ${this.path}: ${e.message}`); return false; }
    this.dirty = false; return true;
  }
}
