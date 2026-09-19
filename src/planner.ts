import { toLatLon } from './geo';
import { CATEGORY_COLOURS, type Pin, type Pins } from './pins';
import { PIN_CATEGORIES } from '../shared/protocol.mjs';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
const hex = (c: number) => '#' + (c >>> 0).toString(16).padStart(6, '0');
const catName = (c: number) => PIN_CATEGORIES[c] ?? 'other';

/** "120 m" under a kilometre, "1.3 km" above it — same rule as the HUD's travelled readout. */
function metres(d: number) { return d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`; }
/** Coarse relative time; pin timestamps are whole seconds. */
function ago(t: number, now = Date.now() / 1000) {
  const s = Math.max(0, now - t);
  if (s < 45) return 'just now';
  if (s < 5400) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** GeoJSON is [longitude, latitude] — the opposite order to everything else here. */
export function toGeoJSON(pins: Pin[]) {
  return {
    type: 'FeatureCollection',
    features: pins.map((p) => {
      const { lat, lon } = toLatLon(p.x, p.z);
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [+lon.toFixed(6), +lat.toFixed(6)] },
        properties: { id: p.id, category: catName(p.cat), note: p.note, votes: p.votes, reported: new Date(p.t * 1000).toISOString() },
      };
    }),
  };
}

/** RFC 4180: quote anything holding a comma, quote or newline; double the internal quotes. */
const csvCell = (v: string | number) => { const s = String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCSV(pins: Pin[]) {
  const rows = [['id', 'category', 'note', 'votes', 'reported', 'lat', 'lon'].join(',')];
  for (const p of pins) {
    const { lat, lon } = toLatLon(p.x, p.z);
    rows.push([p.id, catName(p.cat), p.note, p.votes, new Date(p.t * 1000).toISOString(), lat.toFixed(6), lon.toFixed(6)].map(csvCell).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

function download(name: string, mime: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Planner panel: filter, rank, jump to and export the pins residents have dropped. */
export class Planner {
  open = false;
  onToggle: (() => void) | null = null;
  private wrap = document.getElementById('planner')!;
  private box = document.getElementById('planner-box')!;
  private sum = document.getElementById('pl-sum')!;
  private chips = document.getElementById('pl-cats')!;
  private sortBtn = document.getElementById('pl-sort') as HTMLButtonElement;
  private list = document.getElementById('pl-list')!;
  private cat = -1; // -1 = every category
  private byVotes = false;
  constructor(private pins: Pins, private player: { pos: { x: number; z: number } }, private go: (x: number, z: number, label?: string) => void) {
    const prev = pins.onChange;
    pins.onChange = () => { prev?.(); if (this.open) this.render(); };

    for (let i = -1; i < PIN_CATEGORIES.length; i++) {
      const b = document.createElement('button');
      b.className = 'pl-chip'; b.dataset.cat = String(i); b.textContent = i < 0 ? 'All' : PIN_CATEGORIES[i];
      if (i >= 0) b.style.setProperty('--dot', hex(CATEGORY_COLOURS[i] ?? 0x757575));
      b.onclick = () => { this.cat = i; this.render(); };
      this.chips.appendChild(b);
    }
    this.sortBtn.onclick = () => { this.byVotes = !this.byVotes; this.render(); };
    document.getElementById('pl-geojson')!.onclick = () =>
      download('citypin-pins.geojson', 'application/geo+json', JSON.stringify(toGeoJSON(this.rows()), null, 2));
    document.getElementById('pl-csv')!.onclick = () => download('citypin-pins.csv', 'text/csv', toCSV(this.rows()));
    document.getElementById('pl-close')!.onclick = () => this.toggle(false);
    this.box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') this.toggle(false); });
    this.wrap.addEventListener('click', (e) => { if (e.target === this.wrap) this.toggle(false); });
  }

  toggle(force?: boolean) {
    this.open = force ?? !this.open; this.wrap.classList.toggle('show', this.open);
    if (this.open) { this.render(); this.onToggle?.(); setTimeout(() => this.box.focus(), 0); } else this.box.blur();
  }

  /** The currently filtered, currently sorted set — what the list shows and what the exports write. */
  private rows(): Pin[] {
    const out = [...this.pins.pins.values()].filter((p) => this.cat < 0 || p.cat === this.cat);
    out.sort((a, b) => (this.byVotes ? b.votes - a.votes || b.t - a.t : b.t - a.t || b.votes - a.votes));
    return out;
  }

  render() {
    const all = [...this.pins.pins.values()];
    const votes = all.reduce((a, p) => a + p.votes, 0);
    this.sum.textContent = `${all.length} pin${all.length === 1 ? '' : 's'} · ${votes} vote${votes === 1 ? '' : 's'}`;
    for (const b of this.chips.children) (b as HTMLElement).classList.toggle('on', +(b as HTMLElement).dataset.cat! === this.cat);
    this.sortBtn.textContent = this.byVotes ? 'Most votes' : 'Newest';

    const rows = this.rows(), { x, z } = this.player.pos, now = Date.now() / 1000;
    if (!rows.length) {
      this.list.innerHTML = `<p class="pl-empty">${all.length ? 'No pins in this category yet.' : 'No pins yet — walk the city and drop one where the street fails.'}</p>`;
      return;
    }
    this.list.innerHTML = rows.map((p) => `<button class="pl-row" data-id="${p.id}">` +
      `<span class="pl-dot" style="background:${hex(CATEGORY_COLOURS[p.cat] ?? 0x757575)}"></span>` +
      `<span class="pl-cat">${esc(catName(p.cat))}</span>` +
      `<span class="pl-note">${esc(p.note) || '<i>no note</i>'}</span>` +
      `<span class="pl-votes">▲ ${p.votes | 0}</span>` +
      `<span class="pl-dist">${metres(Math.hypot(p.x - x, p.z - z))}</span>` +
      `<span class="pl-when">${ago(p.t, now)}</span></button>`).join('');
    for (const el of this.list.children) (el as HTMLElement).onclick = () => {
      const id = +(el as HTMLElement).dataset.id!, p = this.pins.pins.get(id);
      if (p) this.go(p.x, p.z, `pin #${id}`);
      this.toggle(false);
    };
  }
}
