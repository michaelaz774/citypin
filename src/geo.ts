export const ORIGIN = { lat: 43.6426, lon: -79.3871 };
const COS = Math.cos((ORIGIN.lat * Math.PI) / 180);

export function toLocal(lat: number, lon: number) {
  return { x: (lon - ORIGIN.lon) * COS * 111320, z: -(lat - ORIGIN.lat) * 110574 };
}
export function toLatLon(x: number, z: number) {
  return { lat: ORIGIN.lat - z / 110574, lon: ORIGIN.lon + x / (COS * 111320) };
}

export interface Building { p: number[][]; h: number; n?: string; k?: string; mh?: number; l?: boolean }
export interface Road { p: number[][]; k: string; n?: string }
export interface Poly { p: number[][] }
export interface Landmark { n: string; x: number; z: number; h: number }
export interface CityData {
  origin: { lat: number; lon: number };
  bbox: { south: number; west: number; north: number; east: number };
  buildings: Building[];
  roads: Road[];
  parks: Poly[];
  water: Poly[];
  coast: Poly[];
  rail: Poly[];
  landmarks: Landmark[];
}

// Approximate neighbourhood rectangles (lat/lon), checked in order; first hit wins.
const HOODS: [string, number, number, number, number][] = [
  // name, south, west, north, east
  ['Financial District', 43.644, -79.386, 43.651, -79.375],
  ['Entertainment District', 43.643, -79.396, 43.650, -79.386],
  ['CityPlace', 43.637, -79.400, 43.643, -79.388],
  ['Harbourfront', 43.633, -79.400, 43.642, -79.370],
  ['South Core', 43.640, -79.388, 43.645, -79.375],
  ['St. Lawrence', 43.644, -79.375, 43.652, -79.362],
  ['Distillery District', 43.648, -79.362, 43.652, -79.355],
  ['Corktown', 43.652, -79.365, 43.659, -79.355],
  ['Moss Park', 43.652, -79.375, 43.660, -79.365],
  ['Garden District', 43.652, -79.381, 43.661, -79.375],
  ['Yonge–Dundas', 43.652, -79.385, 43.658, -79.378],
  ['Grange Park', 43.650, -79.396, 43.656, -79.388],
  ['Chinatown', 43.650, -79.402, 43.656, -79.394],
  ['Kensington Market', 43.652, -79.405, 43.658, -79.398],
  ['Queen West', 43.646, -79.405, 43.652, -79.396],
  ['King West', 43.642, -79.405, 43.648, -79.394],
  ['Discovery District', 43.656, -79.394, 43.662, -79.382],
  ['Bay Street Corridor', 43.652, -79.390, 43.665, -79.382],
  ['Church–Wellesley', 43.658, -79.384, 43.668, -79.375],
  ['Cabbagetown', 43.659, -79.375, 43.672, -79.355],
  ['University of Toronto', 43.658, -79.405, 43.668, -79.392],
  ['Yorkville', 43.668, -79.398, 43.672, -79.380],
  ['The Annex', 43.665, -79.405, 43.672, -79.398],
  ['Rosedale', 43.668, -79.380, 43.672, -79.355],
];
export function neighbourhoodAt(x: number, z: number): string {
  const { lat, lon } = toLatLon(x, z);
  for (const [n, s, w, no, e] of HOODS) if (lat >= s && lat <= no && lon >= w && lon <= e) return n;
  if (lat < 43.633) return 'Lake Ontario';
  return 'Downtown Toronto';
}
