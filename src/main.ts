import * as THREE from 'three';
import { toLocal, type CityData } from './geo';
import { CityCollider, RoadIndex } from './collision';
import { buildWorld } from './world';
import { Input } from './input';
import { Player } from './player';
import { Hud } from './hud';
import { Minimap } from './minimap';
import { Teleporter } from './teleport';
import { PhotoTiles } from './tiles';
import { Net } from './net';
import { Pins } from './pins';
import { Planner } from './planner';
import { TouchControls, isTouchDevice } from './touch';
import * as P from '../shared/protocol.mjs';

const loading = document.getElementById('loading')!;
const setLoading = (t: string) => (loading.querySelector('p')!.textContent = t);

async function loadData(): Promise<CityData> {
  const res = await fetch('/data/toronto.json?v=' + encodeURIComponent(import.meta.env.VITE_DATA_VERSION ?? '4'), { cache: 'no-cache' });
  const total = +(res.headers.get('content-length') ?? 0);
  const reader = res.body!.getReader(); const chunks: Uint8Array[] = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    chunks.push(value); got += value.length;
    setLoading(total ? `Loading downtown Toronto… ${Math.round((got / total) * 100)}%` : `Loading downtown Toronto… ${(got / 1e6).toFixed(1)} MB`);
  }
  const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  return JSON.parse(new TextDecoder().decode(buf));
}

/** Google Maps key: ?key= in the URL, then localStorage, then .env (VITE_GOOGLE_MAPS_API_KEY). Empty = the OpenStreetMap city. */
function resolveKey(): string {
  if (new URLSearchParams(location.search).has('osm')) return ''; // ?osm=1 forces the OpenStreetMap city
  const q = new URLSearchParams(location.search).get('key');
  if (q) { localStorage.setItem('gmaps_key', q); history.replaceState(null, '', location.pathname); return q; }
  return localStorage.getItem('gmaps_key') || (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || '';
}
function wsUrl(): string {
  const q = new URLSearchParams(location.search).get('ws'); if (q) return q; // ?ws=ws://localhost:8791 for testing against another relay
  const env = import.meta.env.VITE_WS_URL as string | undefined; if (env) return env;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:8790`;
}

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const mobile = isTouchDevice();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !mobile, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbfd8ee);
  scene.fog = new THREE.Fog(0xbfd8ee, 900, 3200);
  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.3, 8000);

  const dataP = loadData(); // overlaps with the first tile fetches
  // ENTER is clickable from the first paint; if the world isn't built yet when clicked, the click waits for it
  const enterBtn = document.getElementById('enter') as HTMLButtonElement;
  const nameInput = document.getElementById('name-input') as HTMLInputElement;
  nameInput.value = localStorage.getItem('player_name') ?? '';
  nameInput.onkeydown = (e) => { if (e.key === 'Enter') enterBtn.click(); };
  let clickedEarly = false;
  enterBtn.hidden = false;
  enterBtn.onclick = () => { clickedEarly = true; enterBtn.disabled = true; setLoading('Loading Toronto…'); };
  const key = resolveKey();
  const photo = !!key;

  let tiles: PhotoTiles | null = null;
  if (photo) { tiles = new PhotoTiles(key, camera, renderer, mobile); scene.add(tiles.root); }
  const data = await dataP;
  const collider = new CityCollider(data.buildings);
  const roads = new RoadIndex(data.roads);
  const b = data.bbox;
  const sw = toLocal(b.south, b.west), ne = toLocal(b.north, b.east);
  const bounds = { minX: sw.x, maxX: ne.x, minZ: ne.z, maxZ: sw.z };

  let sun: THREE.DirectionalLight | null = null;
  if (tiles) {
    tiles.onFatal = () => { // quota/billing/key failure: degrade to the free OpenStreetMap city instead of a blank screen
      sessionStorage.setItem('gmaps_skip', '1');
      setLoading('Photorealistic tiles unavailable right now — loading the OpenStreetMap city…');
      setTimeout(() => location.replace(location.pathname + '?osm=1'), 1500);
    };
    scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 2.2)); // props (avatars, markers) are lit; tiles are unlit
    document.getElementById('attrib')!.hidden = false;
  } else {
    setLoading('Building the city…');
    await new Promise((r) => setTimeout(r, 20));
    renderer.shadowMap.enabled = !mobile; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    scene.add(new THREE.HemisphereLight(0xdfeeff, 0x8a8577, 0.9));
    sun = new THREE.DirectionalLight(0xfff2e0, 1.6);
    sun.position.set(-500, 800, 300); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera; sc.near = 10; sc.far = 3000; sc.left = -450; sc.right = 450; sc.top = 450; sc.bottom = -450;
    sun.shadow.bias = -0.0008; scene.add(sun, sun.target);
    buildWorld(data, scene);
  }
  const ground = tiles ?? collider;

  const input = new Input(canvas);
  const touch = mobile ? (input.touch = true, new TouchControls(input)) : null;
  const player = new Player(camera, ground, bounds);
  scene.add(player.avatar.group);
  // spawn on King's College Circle, U of T, facing north toward University College
  const SPAWN = { x: -650, z: -2130, yaw: 0 }; // centre of the King's College Circle field (43.6619, -79.3952)
  player.teleport(SPAWN.x, SPAWN.z, photo ? 160 : 0); player.yaw = SPAWN.yaw; // photo: hover well above any Toronto street until the ground streams in
  // photo mode: after a spawn or teleport, hover until a sharp tile exists under us, then set down on it
  let landing: { x: number; z: number; base: boolean } | null = photo ? { x: SPAWN.x, z: SPAWN.z, base: true } : null;
  const hud = new Hud(roads);
  const teleportTo = (x: number, z: number, label?: string) => {
    if (tiles) { player.teleport(x, z, (tiles.topAt(x, z, 2000, 1e9) ?? player.pos.y) + 3); player.flying = true; landing = { x, z, base: false }; }
    else player.teleport(x, z, collider.topAt(x, z));
    hud.toast(label ? `Teleported to ${label}` : 'Teleported');
  };
  // `net` is created further down (after the world build); the map only reads it while drawing frames, by which time it exists
  const minimap = new Minimap(data, player, (x, z) => teleportTo(x, z), function* () { // everyone live on the map
    for (const r of net.remotes.values()) yield { x: r.avatar.group.position.x, z: r.avatar.group.position.z, kind: 'player' as const }; // nearby: smooth
    for (const [id, p] of net.roster) if (!net.remotes.has(id)) yield { x: p.x, z: p.z, kind: 'player' as const };           // far away: last broadcast
    yield* pins.markers();
  });
  const tp = new Teleporter(data, teleportTo);
  const playersEl = document.getElementById('players')!;

  // landing: wait for the world (and, in photo mode, the ground under the spawn), then hand over to the ENTER button
  let entered = false;
  if (photo) player.flying = true;
  setLoading(''); enterBtn.disabled = false;
  enterBtn.onclick = () => {
    entered = true; loading.classList.add('hide'); if (!mobile) (canvas.requestPointerLock?.() as Promise<void> | undefined)?.catch?.(() => {}); // a browser that refuses the lock (headless, iframe) just runs unlocked
    const nm = nameInput.value.trim(); if (nm) localStorage.setItem('player_name', nm); else localStorage.removeItem('player_name');
    net.setName(nm); player.avatar.setName(net.name);
    hud.toast(mobile ? 'D-pad: move · drag: look · PIN: report the spot under the crosshair · double-tap JUMP: fly' : 'WASD move · P pin the spot under the crosshair · U agree with a pin · L planner panel · F fly · M map', 6);
  };
  if (clickedEarly) enterBtn.click();

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
    tiles?.tiles.setResolutionFromRenderer(camera, renderer);
  });

  // connect only now: the relay times out silent sockets after 10 s, and the synchronous world build above can take that long
  const net = new Net(scene, wsUrl(), player);
  net.name = P.cleanName(nameInput.value); player.avatar.setName(net.name); // known before the socket opens; ENTER may change it
  net.ground = ground;
  const pins = new Pins(scene, net, hud, { osm: collider, tiles });
  const planner = new Planner(pins, player, teleportTo); planner.onToggle = () => { tp.toggle(false); minimap.toggle(false); input.release(); };
  (window as any).__game = { renderer, scene, camera, player, collider, tiles, data, net, input, pins, planner };
  const clock = new THREE.Clock();
  let frames = 0, fpsT = 0, edgeT = 0, reticleShown = false;
  const fpsEl = document.getElementById('fps')!, attribEl = document.getElementById('attrib-text')!, reticleEl = document.getElementById('reticle')!;
  const frame = () => {
    const dt = Math.min(0.05, clock.getDelta());
    if (tiles) {
      tiles.update(dt);
      if (landing) {
        const g = tiles.sharpGround(landing.x, landing.z);
        if (g !== null) {
          if (landing.base) hud.altBase = g;
          const stillThere = Math.hypot(player.pos.x - landing.x, player.pos.z - landing.z) < 30;
          if (stillThere) { player.teleport(landing.x, landing.z, g); player.flying = false; }
          landing = null;
        }
      }
      if (attribEl.textContent !== tiles.attribution) attribEl.textContent = tiles.attribution;
    }
    const uiOpen = tp.open || minimap.open || pins.open || planner.open;
    if (entered) {
      if (input.just('KeyT')) { if (!tp.open) { minimap.toggle(false); input.release(); } tp.toggle(); }
      if (input.just('KeyM')) { if (!minimap.open) { tp.toggle(false); input.release(); } minimap.toggle(); }
      if (input.just('KeyL')) { if (!planner.open) { pins.close(); } planner.toggle(); }
      if (input.just('Escape')) { tp.toggle(false); minimap.toggle(false); pins.close(); planner.toggle(false); }
      if (input.just('KeyR')) { teleportTo(SPAWN.x, SPAWN.z, "King's College Circle"); player.yaw = SPAWN.yaw; player.pitch = 0; }
      if (!uiOpen) player.update(dt, input);
      // pins: P reports the spot under the crosshair, U agrees with the pin we are standing next to
      if (!uiOpen && input.just('KeyP')) pins.compose(camera, player, input);
      if (!uiOpen && input.just('KeyU')) pins.upvoteNear();
      if (player.atEdge && edgeT <= 0) { hud.toast('Edge of the map', 1.5); edgeT = 3; } edgeT -= dt;
      touch?.setContext({ flying: player.flying });
    }
    const showReticle = entered && !uiOpen; if (showReticle !== reticleShown) { reticleShown = showReticle; reticleEl.classList.toggle('show', showReticle); }
    net.update(dt);
    pins.update(dt, player, camera, entered && !uiOpen);
    const online = net.online ? `${net.onlineCount} nearby · ${Math.round(net.rttMs)} ms` : 'offline';
    if (playersEl.textContent !== online) playersEl.textContent = online;
    if (sun) { sun.target.position.copy(player.pos); sun.position.copy(player.pos).add(new THREE.Vector3(-500, 800, 300)); }
    hud.update(dt, player, input.locked || !entered);
    minimap.draw();
    renderer.render(scene, camera);
    input.endFrame();
    frames++; fpsT += dt; if (fpsT >= 1) { fpsEl.textContent = `${frames} fps`; frames = 0; fpsT = 0; }
  };
  (window as any).__game.step = frame;
  renderer.setAnimationLoop(frame);
}

main().catch((e) => { setLoading(`Failed to load: ${e.message}`); console.error(e); });
// a hot update of this module must not run main() a second time on top of the live app (two sockets, two loops)
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
