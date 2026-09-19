import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

/**
 * A resident: a rigged humanoid (three.js' Soldier.glb — Idle/Walk/Run/TPose, ~1.83 m) tinted dark,
 * one AnimationMixer per avatar. Until it has loaded — or if it never does — each avatar is a low-poly
 * box stand-in built from the same palette, so nobody is ever invisible.
 */
const SKIN = 0x9a6a4a, DARK = 0x1b1512, HAIR = 0x120e0c, COAT = 0x141414, TRIM = 0xd4af37, PANTS = 0x1e1e22, SHOE = 0xf2f2f2;
const MODEL_URL = '/models/Soldier.glb';
const LAND_T = 0.22; // landing squash duration

function colored(geo: THREE.BufferGeometry, hex: number, x = 0, y = 0, z = 0) {
  const c = new THREE.Color(hex); const n = geo.attributes.position.count; const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.translate(x, y, z); return geo;
}
const box = (w: number, h: number, d: number, hex: number, x: number, y: number, z: number) => colored(new THREE.BoxGeometry(w, h, d), hex, x, y, z);

let bodyGeo: THREE.BufferGeometry | null = null, limbGeo: { arm: THREE.BufferGeometry; leg: THREE.BufferGeometry } | null = null;
const mat = new THREE.MeshLambertMaterial({ vertexColors: true });

function geos() {
  if (bodyGeo && limbGeo) return { bodyGeo, limbGeo };
  const parts: THREE.BufferGeometry[] = [];
  parts.push(box(0.46, 0.62, 0.28, COAT, 0, 1.13, 0));                        // torso
  parts.push(box(0.50, 0.08, 0.32, TRIM, 0, 1.40, 0));                        // collar trim
  parts.push(box(0.30, 0.12, 0.10, TRIM, 0, 0.97, 0.15));                     // pocket stripe
  parts.push(colored(new THREE.TorusGeometry(0.13, 0.02, 6, 14), TRIM, 0, 1.36, 0.13)); // collar ring
  parts.push(box(0.26, 0.26, 0.26, SKIN, 0, 1.62, 0));                        // head
  parts.push(box(0.28, 0.10, 0.28, HAIR, 0, 1.73, 0));                        // hair
  parts.push(box(0.27, 0.11, 0.27, DARK, 0, 1.53, 0.005));                    // jaw shading
  parts.push(box(0.24, 0.05, 0.06, DARK, 0, 1.62, -0.10));                    // back of head shading
  parts.push(box(0.04, 0.03, 0.02, 0x111111, -0.06, 1.66, 0.135));            // eyes
  parts.push(box(0.04, 0.03, 0.02, 0x111111, 0.06, 1.66, 0.135));
  parts.push(box(0.30, 0.14, 0.28, COAT, 0, 1.78, -0.04));                    // hood
  bodyGeo = mergeGeometries(parts, false)!;
  // limbs are pivoted at the shoulder / hip (origin at top)
  const arm = mergeGeometries([box(0.13, 0.42, 0.13, COAT, 0, -0.21, 0), box(0.11, 0.10, 0.11, SKIN, 0, -0.47, 0)], false)!;
  const leg = mergeGeometries([box(0.17, 0.62, 0.17, PANTS, 0, -0.31, 0), box(0.18, 0.12, 0.26, SHOE, 0, -0.68, 0.04)], false)!;
  limbGeo = { arm, leg };
  return { bodyGeo, limbGeo };
}

type ClipName = 'idle' | 'walk' | 'run' | 'tpose';
interface Template { scene: THREE.Group; clips: Record<ClipName, THREE.AnimationClip> }
interface Rig { pivot: THREE.Group; mixer: THREE.AnimationMixer; actions: Record<ClipName, THREE.AnimationAction>; w: Record<ClipName, number> }

let templateP: Promise<Template | null> | null = null;
/** The GLB is fetched once per page; every avatar clones the skeleton from it. Resolves null (box fallback) on any failure. */
function loadTemplate(): Promise<Template | null> {
  if (templateP) return templateP;
  templateP = new GLTFLoader().loadAsync(MODEL_URL).then((g) => {
    const find = (re: RegExp) => g.animations.find((c) => re.test(c.name));
    const idle = find(/idle/i), walk = find(/walk/i), run = find(/run/i), tpose = find(/t.?pose/i) ?? idle;
    if (!idle || !walk || !run || !tpose) throw new Error('model lacks idle/walk/run clips');
    g.scene.traverse((o) => {
      const m = o as THREE.Mesh; if (!m.isMesh) return;
      m.castShadow = true; m.frustumCulled = false; // skinned bounds don't follow the pose
      const mm = m.material as THREE.MeshStandardMaterial;
      if (mm?.color) mm.color.setHex(/visor/i.test(mm.name) ? TRIM : 0x2c2c30); // texture × dark grey reads as a dark jacket; the visor picks up the trim
    });
    return { scene: g.scene, clips: { idle, walk, run, tpose } };
  }).catch((e) => { console.warn('[avatar] rigged model unavailable, keeping the box stand-in:', e?.message ?? e); return null; });
  return templateP;
}

export class Avatar {
  group = new THREE.Group();
  private arms: THREE.Mesh[] = []; private legs: THREE.Mesh[] = []; private boxParts: THREE.Object3D[] = [];
  private phase = 0;
  private rig: Rig | null = null;
  private wasAirborne = false; private land = 0; private lean = 0;
  private nameShown = '';
  /** Repaint the name tag (players pick their name on the landing screen; remotes arrive before we know theirs). */
  setName(name: string) {
    if (name === this.nameShown) return; this.nameShown = name;
    const tex = this.label.material.map as THREE.CanvasTexture; paintLabel(tex.image as HTMLCanvasElement, name); tex.needsUpdate = true;
  }
  private disposed = false;
  label: THREE.Sprite;
  constructor(name = 'Resident') {
    const { bodyGeo, limbGeo } = geos();
    const body = new THREE.Mesh(bodyGeo, mat); body.castShadow = true; this.group.add(body); this.boxParts.push(body);
    for (const sx of [-1, 1]) {
      const a = new THREE.Mesh(limbGeo.arm, mat); a.position.set(sx * 0.30, 1.40, 0); this.group.add(a); this.arms.push(a); this.boxParts.push(a);
      const l = new THREE.Mesh(limbGeo.leg, mat); l.position.set(sx * 0.11, 0.82, 0); this.group.add(l); this.legs.push(l); this.boxParts.push(l);
    }
    this.label = makeLabel(name); this.label.position.y = 2.15; this.group.add(this.label); this.nameShown = name;
    void loadTemplate().then((t) => { if (t && !this.disposed) this.attachRig(t); });
  }

  /** Swap the box parts for a fresh clone of the rigged model with its own mixer; all clips run, blended by weight. */
  private attachRig(t: Template) {
    const model = cloneSkeleton(t.scene) as THREE.Group;
    const pivot = new THREE.Group(); pivot.rotation.y = Math.PI; pivot.add(model); // Soldier faces -Z; the box (and setPose) face +Z
    const mixer = new THREE.AnimationMixer(model);
    const actions = {} as Record<ClipName, THREE.AnimationAction>;
    for (const k of ['idle', 'walk', 'run', 'tpose'] as ClipName[]) { const a = mixer.clipAction(t.clips[k]); a.play(); a.setEffectiveWeight(k === 'idle' ? 1 : 0); actions[k] = a; }
    for (const p of this.boxParts) this.group.remove(p);
    this.group.scale.set(1, 1, 1); // the box squash lives on the group; the rig's lives on its pivot
    this.group.add(pivot);
    this.rig = { pivot, mixer, actions, w: { idle: 1, walk: 0, run: 0, tpose: 0 } };
  }

  /**
   * speed (m/s) blends idle → walk → run; flying = T-pose with a superman lean that grows with speed;
   * airborne (jumping/falling, not flying) = slow mid-stride pose leaning into the fall, then a squash on landing.
   */
  animate(dt: number, speed: number, flying: boolean, airborne = false) {
    if (!flying && this.wasAirborne && !airborne) this.land = LAND_T;
    this.wasAirborne = airborne && !flying;
    if (this.land > 0) this.land -= dt;
    if (!this.group.visible) return; // first-person self: no need to pose bones
    if (!this.rig) return this.animateBox(dt, speed, flying, airborne);
    const r = this.rig, k = Math.min(1, 8 * dt); // ~0.12 s crossfade
    let idle = 0, walk = 0, run = 0, tpose = 0, lean = 0, walkScale = 1, runScale = 1;
    if (flying) { tpose = 1; lean = Math.min(1.3, (speed / 15) * 1.3); }
    else if (airborne) { run = 1; runScale = 0.12; lean = 0.15; }
    else {
      const m = Math.min(1, speed / 1.2), rr = Math.max(0, Math.min(1, (speed - 5) / 8));
      idle = 1 - m; walk = m * (1 - rr); run = m * rr;
      walkScale = Math.max(0.8, Math.min(2, speed / 3)); runScale = Math.max(0.8, Math.min(2.2, speed / 8));
    }
    const target = { idle, walk, run, tpose };
    for (const n of ['idle', 'walk', 'run', 'tpose'] as ClipName[]) { r.w[n] += (target[n] - r.w[n]) * k; r.actions[n].setEffectiveWeight(r.w[n]); }
    r.actions.walk.setEffectiveTimeScale(walkScale); r.actions.run.setEffectiveTimeScale(runScale);
    this.lean += (lean - this.lean) * k; r.pivot.rotation.x = this.lean;
    const s = this.land > 0 ? Math.sin((Math.PI * this.land) / LAND_T) : 0; // squash then rebound
    r.pivot.scale.set(1 + 0.1 * s, 1 - 0.18 * s, 1 + 0.1 * s);
    r.mixer.update(dt);
  }

  private animateBox(dt: number, speed: number, flying: boolean, airborne: boolean) {
    if (flying || airborne) {
      const armT = flying ? -2.6 : -1.0, legT = flying ? 0.2 : -0.5; // flying: arms forward; airborne: arms up, legs tucked
      for (const a of this.arms) a.rotation.x += (armT - a.rotation.x) * 0.2;
      for (const l of this.legs) l.rotation.x += (legT - l.rotation.x) * 0.2;
      return;
    }
    this.phase += dt * Math.min(12, speed * 1.8);
    const amp = Math.min(0.9, speed * 0.15);
    const s = Math.sin(this.phase) * amp;
    this.legs[0].rotation.x = s; this.legs[1].rotation.x = -s;
    this.arms[0].rotation.x = -s * 0.8; this.arms[1].rotation.x = s * 0.8;
    const sq = this.land > 0 ? Math.sin((Math.PI * this.land) / LAND_T) : 0;
    this.group.scale.set(1 + 0.1 * sq, 1 - 0.18 * sq, 1 + 0.1 * sq);
  }
  /** Face tags always toward the camera; sprites do this automatically. */
  setPose(x: number, y: number, z: number, yaw: number) { this.group.position.set(x, y, z); this.group.rotation.y = yaw; }
  setVisible(v: boolean) { this.group.visible = v; }
  /** Stop a pending rig attach for an avatar that has left the scene. */
  dispose() { this.disposed = true; this.rig?.mixer.stopAllAction(); }
}

function paintLabel(c: HTMLCanvasElement, text: string) {
  const g = c.getContext('2d')!; g.clearRect(0, 0, c.width, c.height);
  g.font = `bold ${text.length > 9 ? 32 : 40}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,.85)'; g.strokeText(text, 128, 34);
  g.fillStyle = '#ffd867'; g.fillText(text, 128, 34);
}
function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  paintLabel(c, text);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(1.6, 0.4, 1); sp.renderOrder = 10;
  return sp;
}
