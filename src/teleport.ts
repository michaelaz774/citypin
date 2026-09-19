import { toLocal, type CityData } from './geo';

/** Address search via Nominatim, bounded to the loaded bbox, plus landmark shortcuts. */
export class Teleporter {
  private wrap = document.getElementById('tp-wrap')!;
  private input = document.getElementById('tp-input') as HTMLInputElement;
  private list = document.getElementById('tp-landmarks')!;
  private status = document.getElementById('tp-status')!;
  open = false;
  constructor(private data: CityData, private go: (x: number, z: number, label: string) => void) {
    for (const l of data.landmarks) {
      const b = document.createElement('button'); b.textContent = l.n;
      b.onclick = () => { this.go(l.x, l.z, l.n); this.toggle(false); };
      this.list.appendChild(b);
    }
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') this.search(this.input.value.trim());
      if (e.key === 'Escape') this.toggle(false);
    });
  }
  toggle(force?: boolean) {
    this.open = force ?? !this.open; this.wrap.classList.toggle('show', this.open);
    if (this.open) { this.status.textContent = ''; setTimeout(() => this.input.focus(), 0); } else this.input.blur();
  }
  async search(q: string) {
    if (!q) return;
    this.status.textContent = 'Searching…';
    const b = this.data.bbox;
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&bounded=1&viewbox=${b.west},${b.north},${b.east},${b.south}&q=${encodeURIComponent(q + ', Toronto')}`;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const arr = (await res.json()) as { lat: string; lon: string; display_name: string }[];
      if (!arr.length) { this.status.textContent = 'Nothing found inside downtown.'; return; }
      const { x, z } = toLocal(+arr[0].lat, +arr[0].lon);
      this.go(x, z, arr[0].display_name.split(',').slice(0, 2).join(','));
      this.toggle(false);
    } catch (e) { this.status.textContent = 'Search failed (offline?).'; }
  }
}
