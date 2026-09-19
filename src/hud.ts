import type { Player } from './player';
import type { RoadIndex } from './collision';
import { neighbourhoodAt } from './geo';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export class Hud {
  private el = {
    hood: document.getElementById('hood')!, street: document.getElementById('street')!,
    speed: document.getElementById('speed')!, alt: document.getElementById('alt')!,
    mode: document.getElementById('mode')!, bearing: document.getElementById('bearing')!,
    dist: document.getElementById('dist')!, toast: document.getElementById('toast')!,
    hint: document.getElementById('hint')!,
  };
  private toastT = 0; private acc = 0;
  altBase = 0; // altitude is shown relative to the spawn's street level
  constructor(private roads: RoadIndex) {}
  toast(msg: string, secs = 2.5) { this.el.toast.textContent = msg; this.el.toast.classList.add('show'); this.toastT = secs; }
  update(dt: number, player: Player, locked: boolean) {
    this.el.hint.classList.toggle('show', !locked);
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) this.el.toast.classList.remove('show'); }
    this.acc += dt; if (this.acc < 0.1) return; this.acc = 0;
    const p = player.pos;
    this.el.hood.textContent = neighbourhoodAt(p.x, p.z);
    const near = this.roads.nearest(p.x, p.z, 40);
    this.el.street.textContent = near ? near.road.n! : '';
    this.el.speed.textContent = `${Math.round(player.speed * 3.6).toString().padStart(3, '0')} km/h`;
    this.el.alt.textContent = `${Math.round(p.y - this.altBase)} m`;
    this.el.mode.textContent = player.flying ? 'FLY  F · walk' : 'WALK  F · fly';
    const h = player.heading;
    this.el.bearing.textContent = `${COMPASS[Math.round(h / 45) % 8]} ${Math.round(h).toString().padStart(3, '0')}°`;
    const km = player.distance / 1000;
    this.el.dist.textContent = km < 1 ? `${Math.round(player.distance)} m` : `${km.toFixed(2)} km`;
  }
}
