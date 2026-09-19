import * as THREE from 'three';
import type { Input } from './input';
import { Avatar } from './avatar';
import * as P from '../shared/protocol.mjs';

/**
 * Walking controller for the city, first or third person:
 *   Click   lock pointer (mouse look), Esc releases
 *   W/A/S/D move (arrows too)      Shift  sprint
 *   Space   jump / rise (fly)      C/Ctrl descend (fly)
 *   F       toggle fly mode        V      first / third person
 */
export interface Vec3Like { x: number; y: number; z: number }
/** Unit XZ normal of the wall a body was pushed away from. */
export interface WallHit { nx: number; nz: number }
/** Anything that can answer "what is the surface height under (x,z)?" and "am I inside a wall?" — OSM footprints or streamed photogrammetry. */
export interface Ground {
  topAt(x: number, z: number, fromY?: number): number | null;
  /**
   * Lateral collision for a vertical cylinder (feet at `pos`, radius, height) that moved there from `from` this frame.
   * Surfaces no higher than pos.y+step are floors (curbs, stairs) and never block; unstreamed geometry never blocks.
   * Corrects pos.x/pos.z in place and returns the normal of the last wall touched, or null when nothing overlapped.
   */
  resolveWalls(from: Vec3Like, pos: Vec3Like, radius: number, height: number, step: number): WallHit | null;
}

const WALK_SPEED = 6, SPRINT_SPEED = 18, FLY_SPEED = 15, FLY_SPRINT_SPEED = 40; // fly sprint capped so full-detail tiles keep up
const GRAVITY = 30, JUMP_SPEED = 9, EYE = 1.7, STEP = 0.6, MAX_FLY_Y = 900;
const RADIUS = 0.35, HEIGHT = 1.8; // collision cylinder
// locomotion: m/s² toward the wanted velocity — a jog winds up fast, a sprint takes ~0.8 s, braking is quicker than either
const WALK_ACCEL = 28, SPRINT_ACCEL = 22, BRAKE = 45, AIR_ACCEL = 6;
const COYOTE = 0.1, HARD_LANDING = 12, RECOVER = 0.25, RECOVER_FACTOR = 0.35; // >12 m/s down (a ~2.4 m drop) buckles the knees

export class Player {
  pos = new THREE.Vector3(0, 0, 0); // feet position
  vel = new THREE.Vector3();
  yaw = 0; pitch = 0;
  flying = false;
  onGround = true;
  airborne = false; // off the ground and not flying (jump or fall)
  airTime = 0;
  fallSpeed = 0; // peak downward speed during the current fall
  /** Fires once per landing with the peak downward speed (m/s). */
  onLand: ((impactSpeed: number) => void) | null = null;
  private coyote = 0; private recover = 0;
  distance = 0; // metres travelled
  maxAlt = 0;
  thirdPerson = true; // spawn seeing your own avatar; V toggles
  avatar = new Avatar(P.DEFAULT_NAME); // shown in third person; hidden in first person
  atEdge = false;
  private bounds: { minX: number; maxX: number; minZ: number; maxZ: number };

  constructor(public camera: THREE.PerspectiveCamera, public ground: Ground, bounds: { minX: number; maxX: number; minZ: number; maxZ: number }) {
    this.bounds = bounds;
    this.avatar.setVisible(this.thirdPerson);
  }

  private updateCamera() {
    const p = this.pos;
    this.camera.rotation.set(0, 0, 0, 'YXZ'); this.camera.rotation.y = this.yaw; this.camera.rotation.x = this.pitch;
    if (!this.thirdPerson) { this.camera.position.set(p.x, p.y + EYE, p.z); return; }
    // centred chase cam: straight back along the look direction, lifted clear of whatever surface is under it
    const dist = 4.2, cp = Math.cos(this.pitch);
    const cx = p.x + Math.sin(this.yaw) * cp * dist, cz = p.z + Math.cos(this.yaw) * cp * dist;
    let cy = p.y + EYE - Math.sin(this.pitch) * dist + 0.45;
    const gy = this.ground.topAt(cx, cz, cy + 30);
    if (gy !== null && cy < gy + 0.6) cy = gy + 0.6;
    this.camera.position.set(cx, cy, cz);
  }

  private lastGround = 0;

  teleport(x: number, z: number, y?: number) {
    this.pos.set(x, y ?? (this.ground.topAt(x, z, 1500) ?? 0), z); this.vel.set(0, 0, 0);
    this.avatar.setPose(this.pos.x, this.pos.y, this.pos.z, this.yaw + Math.PI); // correct on the first rendered frame, before any update()
  }

  /** Surface height under (x,z), sampled from just above the player's head. Null = nothing loaded there yet. */
  groundAt(x: number, z: number): number | null { return this.ground.topAt(x, z, this.pos.y + 2.5); }

  update(dt: number, input: Input) {
    if (input.just('KeyV')) this.thirdPerson = !this.thirdPerson;
    // mouse look
    if (input.locked) {
      this.yaw -= input.mouseDX * 0.0022;
      this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch - input.mouseDY * 0.0022));
    }
    if (input.just('KeyF')) { this.flying = !this.flying; this.vel.y = 0; }

    const sprint = input.down('ShiftLeft') || input.down('ShiftRight');
    const speed = this.flying ? (sprint ? FLY_SPRINT_SPEED : FLY_SPEED) : sprint ? SPRINT_SPEED : WALK_SPEED;

    // yaw-relative movement basis (pitch never tilts movement)
    const fwd = input.axis('KeyS', 'KeyW') + input.axis('ArrowDown', 'ArrowUp');
    const str = input.axis('KeyA', 'KeyD') + input.axis('ArrowLeft', 'ArrowRight');
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let tx = -sy * fwd + cy * str, tz = -cy * fwd - sy * str;
    const tl = Math.hypot(tx, tz); if (tl > 1e-6) { tx = (tx / tl) * speed; tz = (tz / tl) * speed; }

    const p = this.pos, v = this.vel;
    if (this.recover > 0) { this.recover -= dt; tx *= RECOVER_FACTOR; tz *= RECOVER_FACTOR; } // hard landing: a beat to get your legs back
    if (this.flying) {
      v.x += (tx - v.x) * Math.min(1, 12 * dt);
      v.z += (tz - v.z) * Math.min(1, 12 * dt);
      let ty = 0;
      if (input.down('Space')) ty += speed;
      if (input.down('KeyC') || input.down('ControlLeft') || input.down('ControlRight')) ty -= speed;
      v.y += (ty - v.y) * Math.min(1, 12 * dt);
    } else {
      // horizontal: rate-limited acceleration toward the wanted velocity (no instant speed), little authority mid-air
      const dvx = tx - v.x, dvz = tz - v.z, dl = Math.hypot(dvx, dvz);
      if (dl > 1e-6) {
        const braking = tx * tx + tz * tz < v.x * v.x + v.z * v.z;
        const rate = !this.onGround ? AIR_ACCEL : braking ? BRAKE : sprint ? SPRINT_ACCEL : WALK_ACCEL;
        const s = Math.min(dl, rate * dt); v.x += (dvx / dl) * s; v.z += (dvz / dl) * s;
      }
      v.y -= GRAVITY * dt;
      this.coyote = this.onGround ? COYOTE : this.coyote - dt; // a jump still works for 0.1 s after walking off an edge
      if ((this.onGround || this.coyote > 0) && input.down('Space')) { v.y = JUMP_SPEED; this.onGround = false; this.coyote = 0; }
      if (!this.onGround && -v.y > this.fallSpeed) this.fallSpeed = -v.y;
    }

    // horizontal: move, then push out of any wall and slide along it (drop the velocity component pointing into it)
    const before = p.clone();
    p.x += v.x * dt; p.z += v.z * dt;
    const wall = this.ground.resolveWalls(before, p, RADIUS, HEIGHT, STEP);
    if (wall) { const into = v.x * wall.nx + v.z * wall.nz; if (into < 0) { v.x -= into * wall.nx; v.z -= into * wall.nz; } }
    const cx = Math.max(this.bounds.minX, Math.min(this.bounds.maxX, p.x));
    const cz = Math.max(this.bounds.minZ, Math.min(this.bounds.maxZ, p.z));
    this.atEdge = cx !== p.x || cz !== p.z;
    p.x = cx; p.z = cz;

    // vertical
    p.y += v.y * dt;
    let ground = this.groundAt(p.x, p.z);
    // safety net: a surface far above the feet that the wall pass missed (degenerate footprint) is a wall — undo the move
    if (ground !== null && !this.flying && ground > p.y + STEP) { p.x = before.x; p.z = before.z; v.x = v.z = 0; ground = this.groundAt(p.x, p.z); }
    if (ground === null) { ground = this.lastGround; if (!this.flying) { p.y = Math.max(p.y, ground); v.y = 0; } } else this.lastGround = ground;
    if (p.y <= ground) { p.y = ground; if (v.y < 0) v.y = 0; this.onGround = true; }
    else this.onGround = false;
    if (p.y > MAX_FLY_Y) { p.y = MAX_FLY_Y; if (v.y > 0) v.y = 0; }

    // fall state: airborne = off the ground under gravity; landing reports the peak downward speed
    const wasAirborne = this.airborne;
    this.airborne = !this.onGround && !this.flying;
    if (this.airborne) this.airTime += dt;
    else {
      if (wasAirborne && !this.flying) { const impact = this.fallSpeed; if (impact >= HARD_LANDING) this.recover = RECOVER; this.onLand?.(impact); }
      this.fallSpeed = 0; this.airTime = 0;
    }

    this.distance += before.distanceTo(p);
    if (p.y > this.maxAlt) this.maxAlt = p.y;

    this.avatar.setVisible(this.thirdPerson);
    this.avatar.setPose(p.x, p.y, p.z, this.yaw + Math.PI);
    this.avatar.animate(dt, Math.hypot(v.x, v.z), this.flying, this.airborne);
    this.updateCamera();
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.z, this.flying ? this.vel.y : 0); }
  get heading() { // compass degrees, 0 = north (-z)
    let d = (-this.yaw * 180) / Math.PI; d = ((d % 360) + 360) % 360; return d;
  }
}
