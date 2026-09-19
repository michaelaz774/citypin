import * as THREE from 'three';
import * as P from '../shared/protocol.mjs';
import { dirFrom } from '../shared/aim.mjs';
import type { Net } from './net';
import type { Hud } from './hud';
import type { Input } from './input';
import type { Player } from './player';
import type { CityCollider } from './collision';
import type { PhotoTiles } from './tiles';

/** A resident's note about one spot. Position is local metres, x/z only: height is resolved at render time per world mode. */
export interface Pin { id: number; cat: number; x: number; z: number; note: string; votes: number; t: number }
/** One colour per category, same order as P.PIN_CATEGORIES: accessibility, safety, flooding, no shade, transit, green space, other. */
export const CATEGORY_COLOURS = [0x1e5bd8, 0xe53935, 0x0097a7, 0xff9500, 0x8e44ad, 0x2e9e44, 0x777777];
const CATEGORIES: string[] = P.PIN_CATEGORIES;
const REACH = 120, STEP = 1.5, LABEL_RANGE = 90, NEAR = 6, CAPACITY = 5000, RESOLVE_RANGE = 400;
const BEAM_H = 600, BEAM_R = 0.5, RING_R = 1.6, PULSE_S = 1.6; // a beacon: a column of light this tall, a ring at its foot, a pulse when it lands

const _m = new THREE.Matrix4(), _c = new THREE.Color(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const hex = (i: number) => '#' + _c.setHex(CATEGORY_COLOURS[i] ?? 0x777777).getHexString();

/** Vertical alpha ramp for the beam: solid at the foot, gone at the top. */
function beamTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 2; c.height = 128; const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 128); grad.addColorStop(0, 'rgba(255,255,255,.2)'); grad.addColorStop(0.5, 'rgba(255,255,255,.7)'); grad.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = grad; g.fillRect(0, 0, 2, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
/** Soft radial glow for the base ring and the aim target. */
function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 20, 64, 64, 64); grad.addColorStop(0, 'rgba(255,255,255,.95)'); grad.addColorStop(0.55, 'rgba(255,255,255,.35)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** Wrap `text` onto at most `lines` lines that fit `width` at the current font; the last line is cut with an ellipsis. */
function wrap(g: CanvasRenderingContext2D, text: string, width: number, lines: number): string[] {
  const words = text.split(' '); const out: string[] = []; let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width <= width || !line) line = t; else { out.push(line); line = w; if (out.length === lines) break; }
  }
  if (out.length < lines && line) out.push(line);
  if (out.length > lines) out.length = lines;
  if (out.length === lines && g.measureText(out[lines - 1]).width > width) { let s = out[lines - 1]; while (s.length && g.measureText(s + '…').width > width) s = s.slice(0, -1); out[lines - 1] = s + '…'; }
  return out;
}
/** A label: dark rounded card with a colour bar, the category in that colour, and the note wrapped onto two lines. */
function paintLabel(c: HTMLCanvasElement, cat: number, note: string, votes: number) {
  const g = c.getContext('2d')!; const W = c.width, H = c.height; g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(12,14,18,.88)'; g.beginPath(); g.roundRect(8, 8, W - 16, H - 16, 18); g.fill();
  g.fillStyle = hex(cat); g.beginPath(); g.roundRect(8, 8, 14, H - 16, 7); g.fill();
  g.textBaseline = 'middle'; g.textAlign = 'left';
  g.font = 'bold 28px system-ui, sans-serif'; g.fillStyle = hex(cat); g.fillText((CATEGORIES[cat] ?? 'other').toUpperCase(), 40, 36);
  g.font = 'bold 24px system-ui, sans-serif'; g.fillStyle = 'rgba(255,255,255,.75)'; g.textAlign = 'right'; g.fillText(`▲ ${votes}`, W - 24, 36); g.textAlign = 'left';
  g.font = '28px system-ui, sans-serif'; g.fillStyle = '#fff';
  const lines = note ? wrap(g, note, W - 64, 2) : ['(no note)'];
  lines.forEach((l, i) => g.fillText(l, 40, 78 + i * 34));
}
function makeLabel(cat: number, note: string, votes: number): THREE.Sprite {
  const c = document.createElement('canvas'); c.width = 512; c.height = 144;
  paintLabel(c, cat, note, votes);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(4.2, 1.18, 1); sp.renderOrder = 20; sp.center.set(0.5, 0);
  return sp;
}

/**
 * Pins in the world: the store (fed by the relay), the beacons (one instanced column of light per pin, a glowing ring at
 * its foot and a label card), the aim target (where P would put a pin), the placement flow (P: pick a category, write
 * a note) and agreeing with a nearby pin (U).
 */
export class Pins {
  pins = new Map<number, Pin>();
  /** Fires after any change to the store (add, sync, vote) — the planner panel redraws from it. */
  onChange: (() => void) | null = null;
  /** True while the compose dialog is up: main treats it like any other menu. */
  open = false;
  /** The pin we are standing next to, if any. */
  near: Pin | null = null;
  private group = new THREE.Group();
  private beams: THREE.InstancedMesh;
  private rings: THREE.InstancedMesh;
  private target: THREE.Mesh; // where the crosshair ray meets the ground: the spot P would pin
  private targetAt: { x: number; y: number; z: number } | null = null;
  private labels = new Map<number, THREE.Sprite>();
  private ys = new Map<number, number | null>(); // resolved ground height per pin; null until the tiles under it stream in
  private born = new Map<number, number>(); // pins that arrived while we were watching: pulse for a moment
  private synced = false;
  private voted = new Set<number>();
  private aim: { x: number; z: number } | null = null;
  private cat = 0;
  private clock = 0; private frame = 0;
  private wrap = document.getElementById('pin-compose')!;
  private cats = document.getElementById('pin-cats')!;
  private note = document.getElementById('pin-note') as HTMLInputElement;
  private bytes = document.getElementById('pin-bytes')!;
  private where = document.getElementById('pin-where')!;
  private prompt = document.getElementById('pin-prompt')!;
  private promptShown = '';
  private agreeBtn = document.querySelector<HTMLElement>('#tright [data-key="KeyU"]');
  private canvas = document.getElementById('game') as HTMLCanvasElement;
  private touch = false;

  constructor(scene: THREE.Scene, private net: Net, private hud: Hud, private ground: { osm: CityCollider; tiles: PhotoTiles | null }) {
    const beam = new THREE.CylinderGeometry(BEAM_R, BEAM_R * 1.6, BEAM_H, 16, 1, true); beam.translate(0, BEAM_H / 2, 0);
    this.beams = new THREE.InstancedMesh(beam, new THREE.MeshBasicMaterial({ map: beamTexture(), transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, opacity: 0.5, fog: false }), CAPACITY);
    const ring = new THREE.PlaneGeometry(RING_R * 2, RING_R * 2); ring.rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(ring, new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, depthWrite: false, opacity: 0.9 }), CAPACITY);
    for (const im of [this.beams, this.rings]) { im.count = 0; im.frustumCulled = false; im.renderOrder = 12; this.group.add(im); }
    this.target = new THREE.Mesh(ring.clone(), new THREE.MeshBasicMaterial({ map: glowTexture(), color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.target.renderOrder = 13; this.target.visible = false; this.group.add(this.target);
    scene.add(this.group);
    net.onPacket = (dv) => this.handle(dv);
    // compose dialog
    CATEGORIES.forEach((name, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.innerHTML = `<i></i>${name}`;
      b.style.setProperty('--cat', hex(i));
      b.onclick = () => { this.pick(i); this.note.focus(); }; this.cats.appendChild(b);
    });
    this.note.addEventListener('input', () => this.trimNote());
    this.note.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.submit(); else if (e.key === 'Escape') this.close(); });
    this.wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });
    document.getElementById('pin-send')!.onclick = () => this.submit();
    document.getElementById('pin-cancel')!.onclick = () => this.close();
  }

  private handle(dv: DataView) {
    switch (dv.getUint8(0)) {
      case P.S2C.PIN_ADD: { const p = P.decodePinAdd(dv) as Pin; const fresh = !this.pins.has(p.id); this.put(p); if (fresh && this.synced) this.born.set(p.id, this.clock); break; }
      case P.S2C.PIN_SYNC: {
        const list = P.decodePinSync(dv) as Pin[]; const seen = new Set<number>();
        for (const p of list) { seen.add(p.id); this.put(p); }
        for (const id of Array.from(this.pins.keys())) if (!seen.has(id)) this.drop(id);
        this.synced = true;
        break;
      }
      case P.S2C.PIN_VOTE: { const v = P.decodePinVote(dv) as { id: number; votes: number }; const p = this.pins.get(v.id); if (p && p.votes !== v.votes) { p.votes = v.votes; this.repaint(p); } break; }
      default: return;
    }
    this.onChange?.();
  }
  private put(p: Pin) {
    const old = this.pins.get(p.id);
    this.pins.set(p.id, p);
    if (!old || old.x !== p.x || old.z !== p.z) this.ys.set(p.id, null);
    if (!old || old.cat !== p.cat || old.note !== p.note || old.votes !== p.votes) this.repaint(p);
  }
  private repaint(p: Pin) {
    const old = this.labels.get(p.id);
    if (old) { paintLabel(old.material.map!.image as HTMLCanvasElement, p.cat, p.note, p.votes); old.material.map!.needsUpdate = true; return; }
    const l = makeLabel(p.cat, p.note, p.votes); this.labels.set(p.id, l); this.group.add(l);
  }
  private drop(id: number) { this.pins.delete(id); this.ys.delete(id); this.born.delete(id); const l = this.labels.get(id); if (l) { l.removeFromParent(); (l.material.map as THREE.Texture).dispose(); l.material.dispose(); this.labels.delete(id); } }

  /** March the camera ray until it meets the ground or a building; the spot in front of a wall counts. */
  private cast(camera: THREE.Camera, player: Player, reach = REACH, step = STEP): { x: number; y: number; z: number } | null {
    const g = this.ground.tiles ?? this.ground.osm;
    const d = dirFrom(player.yaw, player.pitch); const c = camera.position;
    let px = c.x, py = c.y, pz = c.z;
    for (let t = step; t <= reach; t += step) {
      const x = c.x + d.x * t, y = c.y + d.y * t, z = c.z + d.z * t;
      const s = g.topAt(x, z, y + 2);
      if (s !== null && y <= s) {
        if (s > py + 2) { const s2 = g.topAt(px, pz, py + 2); return s2 === null ? null : { x: px, y: s2, z: pz }; } // walked into a wall: the last point in front of it
        return { x, y: s, z };
      }
      px = x; py = y; pz = z;
    }
    return null;
  }

  /** P: open the compose dialog for the spot under the crosshair. */
  compose(camera: THREE.Camera, player: Player, input: Input) {
    if (this.open) return;
    const hit = this.targetAt ?? this.cast(camera, player);
    if (!hit) { this.hud.toast('Nothing to pin there — aim at the street', 2); return; }
    this.aim = { x: hit.x, z: hit.z }; this.touch = input.touch; this.open = true;
    input.release();
    this.where.textContent = this.hud.whereAt(hit.x, hit.z);
    this.note.value = ''; this.trimNote(); this.pick(this.cat);
    this.wrap.classList.add('show'); setTimeout(() => this.note.focus(), 0);
  }
  private pick(i: number) { this.cat = i; for (const [j, b] of Array.from(this.cats.children).entries()) b.classList.toggle('on', j === i); }
  private trimNote() {
    const v = this.note.value; const clean = P.cleanNote(v) as string; // cut on a character boundary at 48 bytes
    if (P.noteBytes(v).length > P.NOTE_MAX || /[\u0000-\u001f\u007f]/.test(v)) this.note.value = clean;
    const n = P.noteBytes(this.note.value).length; this.bytes.textContent = `${n} / ${P.NOTE_MAX}`; this.bytes.classList.toggle('full', n >= P.NOTE_MAX);
  }
  private submit() {
    if (!this.open || !this.aim) return;
    if (!this.net.online) { this.hud.toast('Offline — the pin cannot be shared right now', 3); this.close(); return; }
    this.net.send(P.encodePlacePin(this.cat, this.aim.x, this.aim.z, this.note.value));
    this.hud.toast(`Pinned · ${CATEGORIES[this.cat]} — everyone can see it now`, 2.5); this.close();
  }
  close() {
    if (!this.open) return;
    this.open = false; this.wrap.classList.remove('show'); this.note.blur();
    if (!this.touch) (this.canvas.requestPointerLock?.() as Promise<void> | undefined)?.catch?.(() => {}); // a rejected lock (no gesture) is fine: the next click locks
  }
  /** U: agree with the pin we are standing next to (once per pin per session; the relay dedups too). */
  upvoteNear() {
    const p = this.near; if (!p) return;
    if (this.voted.has(p.id)) { this.hud.toast('You already agreed with this pin', 1.5); return; }
    if (!this.net.online) { this.hud.toast('Offline — cannot vote right now', 2); return; }
    this.voted.add(p.id); this.net.send(P.encodeUpvotePin(p.id)); this.hud.toast('Agreed — thank you', 1.5); this.promptShown = '';
  }

  /** Resolve heights, place beacons and labels, find the pin within reach, and keep the aim target under the crosshair. */
  update(dt: number, player: Player, camera?: THREE.Camera, aiming = false) {
    this.clock += dt; this.frame++;
    const px = player.pos.x, pz = player.pos.z;
    let n = 0, near: Pin | null = null, nd = NEAR;
    for (const p of this.pins.values()) {
      const dx = p.x - px, dz = p.z - pz, dist = Math.hypot(dx, dz);
      let y = this.ys.get(p.id);
      if (y === undefined || y === null || dist < RESOLVE_RANGE) {
        y = this.ground.tiles ? this.ground.tiles.sharpGround(p.x, p.z) : this.ground.osm.topAt(p.x, p.z);
        this.ys.set(p.id, y);
      }
      const label = this.labels.get(p.id);
      if (y === null) { if (label) label.visible = false; continue; } // photorealistic tiles not streamed in here yet: hold it hidden
      const age = this.born.has(p.id) ? this.clock - this.born.get(p.id)! : PULSE_S; if (age >= PULSE_S) this.born.delete(p.id);
      const pulse = 1 + 2.5 * Math.max(0, 1 - age / PULSE_S) ** 2; // lands wide and bright, settles in a second and a half
      const breathe = 1 + 0.08 * Math.sin(this.clock * 2.2 + p.id);
      const far = Math.max(1, dist / 70); // a beacon a kilometre away is still a few pixels wide
      _c.setHex(CATEGORY_COLOURS[p.cat] ?? 0x777777);
      _m.compose(_p.set(p.x, y, p.z), _q.identity(), _s.set(pulse * breathe * far, 1, pulse * breathe * far)); this.beams.setMatrixAt(n, _m); this.beams.setColorAt(n, _c);
      _m.compose(_p.set(p.x, y + 0.06, p.z), _q, _s.set(pulse * breathe * 1.3, 1, pulse * breathe * 1.3)); this.rings.setMatrixAt(n, _m); this.rings.setColorAt(n, _c);
      n++;
      if (label) { label.visible = dist < LABEL_RANGE; label.position.set(p.x, y + 2.4, p.z); label.material.opacity = Math.min(1, (LABEL_RANGE - dist) / 25); }
      if (dist < nd && Math.abs(y - player.pos.y) < 4) { nd = dist; near = p; }
    }
    for (const im of [this.beams, this.rings]) { im.count = n; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
    // the aim target: refreshed every other frame while walking with no menu open
    if (aiming && camera && !this.open) {
      if (this.frame % 2 === 0) this.targetAt = this.cast(camera, player, 80, 2);
    } else this.targetAt = null;
    const t = this.targetAt;
    this.target.visible = !!t && !near;
    if (t) { this.target.position.set(t.x, t.y + 0.05, t.z); const k = 0.9 + 0.12 * Math.sin(this.clock * 4); this.target.scale.set(k, 1, k); }
    // the prompt: the nearby pin wins over the aim hint
    const touch = document.body.classList.contains('touch');
    const text = near
      ? (this.voted.has(near.id) ? `✓ You agreed · ${near.votes} ${near.votes === 1 ? 'person agrees' : 'people agree'}` : `${touch ? 'AGREE' : 'U'} · agree with this pin · ${near.votes} ${near.votes === 1 ? 'person agrees' : 'people agree'}`)
      : t ? `${touch ? 'PIN' : 'Click'} · pin this spot` : '';
    if (near !== this.near || text !== this.promptShown) {
      this.near = near; this.promptShown = text;
      this.prompt.textContent = text; this.prompt.classList.toggle('near', !!near);
      this.prompt.style.opacity = text ? '1' : '0';
      if (this.agreeBtn) this.agreeBtn.hidden = !near;
    }
  }
  /** Map symbols for the minimap. */
  *markers(): Iterable<{ x: number; z: number; kind: 'pin'; cat: number }> {
    for (const p of this.pins.values()) yield { x: p.x, z: p.z, kind: 'pin', cat: p.cat };
  }
}
