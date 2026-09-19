import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin } from '3d-tiles-renderer/core/plugins';
import { GLTFExtensionsPlugin, TileCompressionPlugin, TilesFadePlugin, ReorientationPlugin } from '3d-tiles-renderer/three/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { ORIGIN } from './geo';
import type { Ground, WallHit, Vec3Like } from './player';

// BVH-accelerated raycasts against every tile mesh (3 rays/frame for the walker).
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/**
 * Google Photorealistic 3D Tiles, re-centred so the CN Tower base sits at the origin (X/Z) with Y up.
 * Heights are left in Google's native frame (metres above the WGS84 ellipsoid; downtown Toronto is ~40–90 m up),
 * so every client shares one coordinate frame with nothing to calibrate.
 * ReorientationPlugin yields X-west / Z-north; the wrapper group's half-turn makes it X-east / Z-south
 * to match the OSM data frame used by the minimap, street names and landmarks.
 */
export class PhotoTiles implements Ground {
  tiles: TilesRenderer;
  root = new THREE.Group();
  private ray = new THREE.Raycaster();
  private down = new THREE.Vector3(0, -1, 0);
  private hits: THREE.Intersection[] = [];
  lastHitError = Infinity;
  attribution = '';
  private attrT = 0;
  /** Fired once when Google refuses to serve (bad key, quota exhausted, billing off); the app falls back to the OSM city. */
  onFatal: ((reason: string) => void) | null = null;
  private fatal = false;

  constructor(apiKey: string, private camera: THREE.PerspectiveCamera, private renderer: THREE.WebGLRenderer, mobile = false) {
    const tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true }));
    const draco = new DRACOLoader(); draco.setDecoderPath('/draco/');
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
    tiles.registerPlugin(new TileCompressionPlugin());
    tiles.registerPlugin(new TilesFadePlugin({ fadeDuration: 300, maximumFadeOutTiles: 200 }));
    tiles.registerPlugin(new ReorientationPlugin({ lat: (ORIGIN.lat * Math.PI) / 180, lon: (ORIGIN.lon * Math.PI) / 180, height: 0 }));
    tiles.errorTarget = mobile ? 20 : 12; // desktop: sharper than Google's recommended 20; phones: the recommended value, GPU and memory are the limit
    // Hard caps: once the cache is full the renderer stops refining and leaves coarse tiles in place,
    // so give it room, and let far-away tiles settle for less detail (fog-style falloff) to keep the budget for what's near.
    // Phones: Safari kills a tab past ~1 GB, so keep the tile cache small there.
    tiles.lruCache.maxBytesSize = (mobile ? 320 : 1600) * 1024 * 1024;
    tiles.lruCache.minSize = mobile ? 1200 : 4000; tiles.lruCache.maxSize = mobile ? 5000 : 24000;
    tiles.errorFalloff = 8; tiles.errorFalloffDensity = 3e-4;
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.addEventListener('load-model', (e: any) => {
      e.scene.traverse((o: THREE.Object3D) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        (m.geometry as any).computeBoundsTree({ maxLeafTris: 8 });
        // Photogrammetry textures are already lit; render them unlit so baked shadows aren't shaded twice.
        const old = m.material as THREE.MeshStandardMaterial;
        if (old && (old as any).map) { m.material = new THREE.MeshBasicMaterial({ map: (old as any).map }); old.dispose(); }
      });
    });
    tiles.addEventListener('dispose-model', (e: any) => {
      e.scene.traverse((o: THREE.Object3D) => { const m = o as THREE.Mesh; if (m.isMesh) (m.geometry as any).disposeBoundsTree?.(); });
    });
    tiles.addEventListener('load-error', (e: any) => {
      const msg = String(e.error?.message ?? e.error ?? '');
      console.warn('[tiles] load error', msg, e.model?.url || e.tileset?.url);
      // a refused key comes back as an error body, not a status, and the library trips on the missing tileset fields: if the root
      // never loaded there is nothing to render in photo mode, so any root failure is fatal (the app falls back to the OSM city)
      const rootFailed = !tiles.root;
      if (!this.fatal && (rootFailed || /\b(401|403|429)\b|quota|PERMISSION_DENIED|RESOURCE_EXHAUSTED|API key/i.test(msg))) { this.fatal = true; this.onFatal?.(rootFailed ? `root tileset failed (key refused for this site?): ${msg}` : msg); }
    });
    this.root.rotation.y = Math.PI;
    this.root.add(tiles.group);
    this.tiles = tiles;
  }

  /**
   * Surface height under (x,z) from a ray starting at fromY. Only tiles with geometric error <= maxErr count,
   * so coarse placeholder LODs (error 32–64 m) never act as ground. Null = nothing usable loaded there yet.
   */
  topAt(x: number, z: number, fromY = 1000, maxErr = 20): number | null {
    this.ray.set(new THREE.Vector3(x, fromY, z), this.down);
    this.ray.far = fromY + 200;
    this.hits.length = 0;
    (this.tiles as any).raycast(this.ray, this.hits);
    let best = -Infinity, err = Infinity;
    for (const h of this.hits) {
      const e = (h.object.userData.tile?.geometricError ?? 0) as number;
      if (e > maxErr) continue;
      if (h.point.y > best) { best = h.point.y; err = e; }
    }
    if (best === -Infinity) return null;
    this.lastHitError = err;
    return best;
  }

  /** Nearest hit along a ray from `o` in unit direction `d` within `far`, from tiles sharp enough to count. */
  private castNear(o: THREE.Vector3, d: THREE.Vector3, far: number, maxErr: number): number {
    this.ray.set(o, d); this.ray.far = far; this.hits.length = 0;
    (this.tiles as any).raycast(this.ray, this.hits);
    let best = Infinity;
    for (const h of this.hits) if ((h.object.userData.tile?.geometricError ?? 0) <= maxErr && h.distance < best) best = h.distance;
    return best;
  }

  private static DIRS = Array.from({ length: 8 }, (_, i) => new THREE.Vector3(Math.cos((i * Math.PI) / 4), 0, Math.sin((i * Math.PI) / 4)));
  private o = new THREE.Vector3(); private d = new THREE.Vector3();
  /**
   * Walls from the photogrammetry mesh: a sweep ray from where we came (catches tunnelling through thin walls at sprint speed)
   * then a star of horizontal rays at knee and chest height, each pushing the cylinder out by its penetration.
   * Photogrammetry is only front-faced, so the sweep is what keeps a body from ending up inside a building.
   */
  resolveWalls(from: Vec3Like, pos: Vec3Like, radius: number, height: number, step: number, maxErr = 20): WallHit | null {
    const heights = [step + 0.1, height - 0.15];
    let hit: WallHit | null = null;
    const mx = pos.x - from.x, mz = pos.z - from.z, ml = Math.hypot(mx, mz);
    if (ml > 1e-4) {
      this.d.set(mx / ml, 0, mz / ml);
      let stop = Infinity;
      for (const h of heights) { this.o.set(from.x, pos.y + h, from.z); stop = Math.min(stop, this.castNear(this.o, this.d, ml + radius, maxErr)); }
      if (stop < ml + radius) {
        const t = Math.max(0, stop - radius);
        pos.x = from.x + this.d.x * t; pos.z = from.z + this.d.z * t; hit = { nx: -this.d.x, nz: -this.d.z };
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (const dir of PhotoTiles.DIRS) for (const h of heights) {
        this.o.set(pos.x, pos.y + h, pos.z);
        const dist = this.castNear(this.o, dir, radius, maxErr);
        if (dist >= radius) continue;
        const push = radius - dist; pos.x -= dir.x * push; pos.z -= dir.z * push; moved = true; hit = { nx: -dir.x, nz: -dir.z };
      }
      if (!moved) break;
    }
    return hit;
  }

  /** Ground under (x,z) from a reasonably sharp tile (geometric error <= 8 m), or null until one has streamed in. */
  sharpGround(x: number, z: number): number | null { return this.topAt(x, z, 2000, 8); }

  update(dt: number) {
    this.camera.updateMatrixWorld();
    this.tiles.update();
    this.attrT += dt;
    if (this.attrT > 2) {
      this.attrT = 0;
      const a = this.tiles.getAttributions([]).map((x) => String(x.value)).filter(Boolean);
      this.attribution = a.join(' · ');
    }
  }
  get loading() { return this.tiles.loadProgress < 1; }
}
