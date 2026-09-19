import type { CityData } from './geo';
import type { Player } from './player';
import { CATEGORY_COLOURS } from './pins';

export interface Marker { x: number; z: number; kind: 'player' | 'pin'; heading?: number; cat?: number }

/** One map symbol: a player is a red dot with a white ring so it pops on any ground colour; a pin is a smaller dot in its category colour. */
function drawMarker(c: CanvasRenderingContext2D, x: number, z: number, m: Marker, s: number) {
  c.lineJoin = 'round';
  if (m.kind === 'pin') {
    c.fillStyle = '#' + (CATEGORY_COLOURS[m.cat ?? 6] ?? 0x777777).toString(16).padStart(6, '0'); c.strokeStyle = '#111'; c.lineWidth = 1.5 * s;
    c.beginPath(); c.arc(x, z, 4 * s, 0, 7); c.fill(); c.stroke(); return;
  }
  c.fillStyle = '#ff3b30'; c.strokeStyle = '#fff'; c.lineWidth = 2 * s;
  c.beginPath(); c.arc(x, z, 5 * s, 0, 7); c.fill(); c.stroke();
}

/** North-up minimap rendered from the vector data into an offscreen canvas; click on the big map (M) to teleport. */
export class Minimap {
  private off: HTMLCanvasElement; private scale = 0.5; // px per metre
  private minX: number; private minZ: number;
  private mini = document.getElementById('minimap') as HTMLCanvasElement;
  private big = document.getElementById('bigmap') as HTMLCanvasElement;
  private bigWrap = document.getElementById('bigmap-wrap')!;
  open = false;
  /** `markers` yields everything live to draw over the map (a getter because Net is created after the map). */
  constructor(data: CityData, private player: Player, private onTeleport: (x: number, z: number) => void, private markers: () => Iterable<Marker> = () => []) {
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const r of data.roads) for (const [x, z] of r.p) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
    this.minX = minX; this.minZ = minZ;
    const w = Math.ceil((maxX - minX) * this.scale), h = Math.ceil((maxZ - minZ) * this.scale);
    this.off = document.createElement('canvas'); this.off.width = w; this.off.height = h;
    const c = this.off.getContext('2d')!;
    c.fillStyle = '#e8e4da'; c.fillRect(0, 0, w, h);
    const px = (x: number) => (x - minX) * this.scale, pz = (z: number) => (z - minZ) * this.scale;
    const poly = (p: number[][], fill: string) => { c.beginPath(); p.forEach(([x, z], i) => i ? c.lineTo(px(x), pz(z)) : c.moveTo(px(x), pz(z))); c.closePath(); c.fillStyle = fill; c.fill(); };
    for (const p of data.water) poly(p.p, '#8fbbe0');
    for (const p of data.parks) poly(p.p, '#a9d18e');
    c.fillStyle = '#c9c4b8';
    for (const b of data.buildings) poly(b.p, b.h > 100 ? '#9a948a' : '#c9c4b8');
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (const r of data.roads) {
      const major = /primary|secondary|trunk|motorway/.test(r.k);
      c.strokeStyle = major ? '#ffffff' : '#f4f2ee'; c.lineWidth = major ? 3 : 1.5;
      c.beginPath(); r.p.forEach(([x, z], i) => i ? c.lineTo(px(x), pz(z)) : c.moveTo(px(x), pz(z))); c.stroke();
    }
    c.fillStyle = '#1a1a1a'; c.font = 'bold 11px system-ui';
    for (const l of data.landmarks) { c.beginPath(); c.arc(px(l.x), pz(l.z), 3, 0, 7); c.fill(); c.fillText(l.n, px(l.x) + 5, pz(l.z) + 4); }

    this.big.width = w; this.big.height = h;
    this.big.addEventListener('click', (e) => {
      const r = this.big.getBoundingClientRect();
      const sx = (e.clientX - r.left) * (w / r.width), sz = (e.clientY - r.top) * (h / r.height);
      this.onTeleport(minX + sx / this.scale, minZ + sz / this.scale);
      this.toggle(false);
    });
    this.mini.addEventListener('click', () => this.toggle(true));
  }
  toggle(force?: boolean) { this.open = force ?? !this.open; this.bigWrap.classList.toggle('show', this.open); }
  draw() {
    const p = this.player.pos;
    const cx = (p.x - this.minX) * this.scale, cz = (p.z - this.minZ) * this.scale;
    const ctx = this.mini.getContext('2d')!; const S = this.mini.width, R = 180; // 180px half-window => 360 m
    ctx.fillStyle = '#e8e4da'; ctx.fillRect(0, 0, S, S);
    ctx.drawImage(this.off, cx - R, cz - R, R * 2, R * 2, 0, 0, S, S);
    // live markers, clipped to the window; the big map draws them all when open
    const k = S / (2 * R), bc = this.open ? this.big.getContext('2d')! : null;
    const bs = bc ? Math.max(1, this.big.width / Math.max(1, this.big.getBoundingClientRect().width)) : 1; // the big canvas is shown shrunk: keep symbols screen-sized
    if (bc) bc.drawImage(this.off, 0, 0);
    for (const m of this.markers()) {
      const ox = (m.x - this.minX) * this.scale, oz = (m.z - this.minZ) * this.scale;
      const mx = S / 2 + (ox - cx) * k, mz = S / 2 + (oz - cz) * k;
      if (mx >= 0 && mx <= S && mz >= 0 && mz <= S) drawMarker(ctx, mx, mz, m, 1);
      if (bc && ox >= 0 && ox <= this.big.width && oz >= 0 && oz <= this.big.height) drawMarker(bc, ox, oz, m, bs);
    }
    ctx.save(); ctx.translate(S / 2, S / 2); ctx.rotate((this.player.heading * Math.PI) / 180);
    ctx.fillStyle = '#ff3b30'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(7, 8); ctx.lineTo(0, 5); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
    if (bc) {
      bc.fillStyle = '#ff3b30'; bc.beginPath(); bc.arc(cx, cz, 6 * bs, 0, 7); bc.fill();
      bc.strokeStyle = '#fff'; bc.lineWidth = 2 * bs; bc.stroke();
    }
  }
}
