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
const REACH = 120, STEP = 1.5, LABEL_RANGE = 80, NEAR = 6, CAPACITY = 5000, RESOLVE_RANGE = 400;

const _m = new THREE.Matrix4(), _c = new THREE.Color();

function paintLabel(c: HTMLCanvasElement, cat: number, note: string) {
  const g = c.getContext('2d')!; g.clearRect(0, 0, c.width, c.height);
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,.85)';
  g.font = 'bold 30px system-ui, sans-serif'; g.strokeText(CATEGORIES[cat] ?? 'other', 256, 26);
  g.fillStyle = '#' + _c.setHex(CATEGORY_COLOURS[cat] ?? 0x777777).getHexString(); g.fillText(CATEGORIES[cat] ?? 'other', 256, 26);
  if (note) { g.font = '26px system-ui, sans-serif'; g.strokeText(note, 256, 66); g.fillStyle = '#fff'; g.fillText(note, 256, 66); }
}
function makeLabel(cat: number, note: string): THREE.Sprite {
  const c = document.createElement('canvas'); c.width = 512; c.height = 96;
  paintLabel(c, cat, note);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(4.8, 0.9, 1); sp.renderOrder = 20;
  return sp;
}

/**
 * Pins in the world: the store (fed by the relay), the markers (one instanced cone per pin plus a label sprite), the
 * placement flow (P: aim at a spot, pick a category, write a note) and agreeing with a nearby pin (U).
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
  private cones: THREE.InstancedMesh;
  private labels = new Map<number, THREE.Sprite>();
  private ys = new Map<number, number | null>(); // resolved ground height per pin; null until the tiles under it stream in
  private voted = new Set<number>();
  private aim: { x: number; z: number } | null = null;
  private cat = 0;
  private wrap = document.getElementById('pin-compose')!;
  private cats = document.getElementById('pin-cats')!;
  private note = document.getElementById('pin-note') as HTMLInputElement;
  private bytes = document.getElementById('pin-bytes')!;
  private prompt = document.getElementById('pin-prompt')!;
  private agreeBtn = document.querySelector<HTMLElement>('#tright [data-key="KeyU"]');
  private canvas = document.getElementById('game') as HTMLCanvasElement;
  private touch = false;

  constructor(scene: THREE.Scene, private net: Net, private hud: Hud, private ground: { osm: CityCollider; tiles: PhotoTiles | null }) {
    const geo = new THREE.ConeGeometry(0.5, 1.6, 8);
    this.cones = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ depthTest: false }), CAPACITY);
    this.cones.count = 0; this.cones.renderOrder = 15; this.cones.frustumCulled = false;
    this.group.add(this.cones); scene.add(this.group);
    net.onPacket = (dv) => this.handle(dv);
    // compose dialog
    CATEGORIES.forEach((name, i) => {
      const b = document.createElement('button'); b.textContent = name; b.type = 'button';
      b.style.setProperty('--cat', '#' + _c.setHex(CATEGORY_COLOURS[i]).getHexString());
      b.onclick = () => this.pick(i); this.cats.appendChild(b);
    });
    this.note.addEventListener('input', () => this.trimNote());
    this.note.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.submit(); else if (e.key === 'Escape') this.close(); });
    document.getElementById('pin-send')!.onclick = () => this.submit();
    document.getElementById('pin-cancel')!.onclick = () => this.close();
  }

  private handle(dv: DataView) {
    switch (dv.getUint8(0)) {
      case P.S2C.PIN_ADD: { const p = P.decodePinAdd(dv) as Pin; this.put(p); break; }
      case P.S2C.PIN_SYNC: {
        const list = P.decodePinSync(dv) as Pin[]; const seen = new Set<number>();
        for (const p of list) { seen.add(p.id); this.put(p); }
        for (const id of Array.from(this.pins.keys())) if (!seen.has(id)) this.drop(id);
        break;
      }
      case P.S2C.PIN_VOTE: { const v = P.decodePinVote(dv) as { id: number; votes: number }; const p = this.pins.get(v.id); if (p) p.votes = v.votes; break; }
      default: return;
    }
    this.onChange?.();
  }
  private put(p: Pin) {
    const old = this.pins.get(p.id);
    this.pins.set(p.id, p);
    if (!old || old.x !== p.x || old.z !== p.z) this.ys.set(p.id, null);
    if (!old || old.cat !== p.cat || old.note !== p.note) { this.labels.get(p.id)?.removeFromParent(); const l = makeLabel(p.cat, p.note); this.labels.set(p.id, l); this.group.add(l); }
  }
  private drop(id: number) { this.pins.delete(id); this.ys.delete(id); const l = this.labels.get(id); if (l) { l.removeFromParent(); (l.material.map as THREE.Texture).dispose(); l.material.dispose(); this.labels.delete(id); } }

  /** P: march the camera ray until it meets the ground or a building, then open the compose dialog for that spot. */
  compose(camera: THREE.Camera, player: Player, input: Input) {
    if (this.open) return;
    const g = this.ground.tiles ?? this.ground.osm;
    const d = dirFrom(player.yaw, player.pitch); const c = camera.position;
    let hit: { x: number; z: number } | null = null, px = c.x, pz = c.z;
    for (let t = STEP; t <= REACH; t += STEP) {
      const x = c.x + d.x * t, y = c.y + d.y * t, z = c.z + d.z * t;
      const s = g.topAt(x, z, y + 2);
      if (s !== null && y <= s) { hit = s > c.y + d.y * (t - STEP) + 2 ? { x: px, z: pz } : { x, z }; break; } // walked into a wall: pin the last point in front of it
      px = x; pz = z;
    }
    if (!hit) { this.hud.toast('Nothing to pin there — aim at the street', 2); return; }
    this.aim = hit; this.touch = input.touch; this.open = true;
    input.release();
    this.note.value = ''; this.trimNote(); this.pick(this.cat);
    this.wrap.classList.add('show'); setTimeout(() => this.note.focus(), 0);
  }
  private pick(i: number) { this.cat = i; for (const [j, b] of Array.from(this.cats.children).entries()) b.classList.toggle('on', j === i); }
  private trimNote() {
    const v = this.note.value; const clean = P.cleanNote(v) as string; // cut on a character boundary at 48 bytes
    if (P.noteBytes(v).length > P.NOTE_MAX || /[\u0000-\u001f\u007f]/.test(v)) this.note.value = clean;
    this.bytes.textContent = `${P.noteBytes(this.note.value).length} / ${P.NOTE_MAX}`;
  }
  private submit() {
    if (!this.open || !this.aim) return;
    if (!this.net.online) { this.hud.toast('Offline — the pin cannot be shared right now', 3); this.close(); return; }
    this.net.send(P.encodePlacePin(this.cat, this.aim.x, this.aim.z, this.note.value));
    this.hud.toast(`Pinned: ${CATEGORIES[this.cat]}`, 2); this.close();
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
    this.voted.add(p.id); this.net.send(P.encodeUpvotePin(p.id)); this.hud.toast('Agreed', 1.2);
  }

  /** Resolve heights, place cones and labels, and find the pin within reach. */
  update(_dt: number, player: Player) {
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
      _m.makeTranslation(p.x, y + 0.8, p.z); this.cones.setMatrixAt(n, _m); this.cones.setColorAt(n, _c.setHex(CATEGORY_COLOURS[p.cat] ?? 0x777777)); n++;
      if (label) { label.visible = dist < LABEL_RANGE; label.position.set(p.x, y + 2.3, p.z); }
      if (dist < nd && Math.abs(y - player.pos.y) < 4) { nd = dist; near = p; }
    }
    this.cones.count = n; this.cones.instanceMatrix.needsUpdate = true; if (this.cones.instanceColor) this.cones.instanceColor.needsUpdate = true;
    if (near !== this.near || (near && this.prompt.dataset.votes !== String(near.votes))) {
      this.near = near;
      if (near) { this.prompt.textContent = `${document.body.classList.contains('touch') ? 'AGREE' : 'U'} · agree with this pin (${near.votes} ${near.votes === 1 ? 'vote' : 'votes'})`; this.prompt.dataset.votes = String(near.votes); }
      this.prompt.style.opacity = near ? '1' : '0';
      if (this.agreeBtn) this.agreeBtn.hidden = !near;
    }
  }
  /** Map symbols for the minimap. */
  *markers(): Iterable<{ x: number; z: number; kind: 'pin'; cat: number }> {
    for (const p of this.pins.values()) yield { x: p.x, z: p.z, kind: 'pin', cat: p.cat };
  }
}
