// Pure helpers for the map view: events -> markers, paths and bounds.
import type { Event, EventType } from '@planfully/shared';

export type LatLng = { lat: number; lng: number };

export type Marker = {
  eventId: string;
  lat: number;
  lng: number;
  type: EventType;
  label: string;
  /** 'end' for the arrival point of a transport event. */
  role: 'start' | 'end';
};

export type Path = { eventId: string; type: EventType; from: LatLng; to: LatLng };

export type Bounds = { north: number; south: number; east: number; west: number };

export type MapModel = { markers: Marker[]; paths: Path[]; bounds: Bounds | null };

const TRANSPORT: ReadonlySet<EventType> = new Set(['flight', 'train', 'bus', 'ferry', 'car']);
export const isTransport = (t: EventType): boolean => TRANSPORT.has(t);

/** Spread radius in degrees (about 15 m) for markers that share a coordinate. */
export const SPREAD_DEG = 0.00015;

function point(loc: { lat?: number; lng?: number } | undefined): LatLng | null {
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
  return { lat: loc.lat, lng: loc.lng };
}

/** Markers at identical coordinates are placed on a small circle around the shared point. */
function spread(markers: Marker[]): Marker[] {
  const groups = new Map<string, number[]>();
  markers.forEach((m, i) => {
    const key = `${m.lat.toFixed(5)},${m.lng.toFixed(5)}`;
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });
  const out = markers.slice();
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    idx.forEach((i, k) => {
      const m = markers[i];
      if (!m) return;
      const angle = (2 * Math.PI * k) / idx.length;
      const cos = Math.max(0.1, Math.cos((m.lat * Math.PI) / 180));
      out[i] = {
        ...m,
        lat: m.lat + SPREAD_DEG * Math.sin(angle),
        lng: m.lng + (SPREAD_DEG * Math.cos(angle)) / cos,
      };
    });
  }
  return out;
}

/**
 * Smallest box around the points. Longitude is the smallest enclosing arc, so points at 178 and
 * -178 give west 178, east -178 (east < west means the box crosses the antimeridian, which Google's
 * LatLngBounds literal understands).
 */
export function boundsOf(points: readonly LatLng[]): Bounds | null {
  if (points.length === 0) return null;
  let north = -90;
  let south = 90;
  for (const p of points) {
    north = Math.max(north, p.lat);
    south = Math.min(south, p.lat);
  }
  const lngs = points.map((p) => p.lng).sort((x, y) => x - y);
  const first = lngs[0] ?? 0;
  const last = lngs[lngs.length - 1] ?? 0;
  // Largest empty gap between neighbours (including the wrap from last back to first).
  let gap = first + 360 - last;
  let west = first;
  let east = last;
  for (let i = 1; i < lngs.length; i++) {
    const g = (lngs[i] ?? 0) - (lngs[i - 1] ?? 0);
    if (g > gap) {
      gap = g;
      west = lngs[i] ?? 0;
      east = lngs[i - 1] ?? 0;
    }
  }
  return { north, south, east, west };
}

/** Events with coordinates, in input order. */
export function locatedEvents(events: readonly Event[]): Event[] {
  return events.filter((e) => point(e.location) || (isTransport(e.type) && point(e.endLocation)));
}

export function buildMapModel(events: readonly Event[]): MapModel {
  const markers: Marker[] = [];
  const paths: Path[] = [];
  for (const e of events) {
    const from = point(e.location);
    const to = isTransport(e.type) ? point(e.endLocation) : null;
    if (from) markers.push({ eventId: e.id, ...from, type: e.type, label: e.name, role: 'start' });
    if (to) markers.push({ eventId: e.id, ...to, type: e.type, label: e.name, role: 'end' });
    if (from && to) paths.push({ eventId: e.id, type: e.type, from, to });
  }
  // Bounds come from the true coordinates, not the spread ones.
  const bounds = boundsOf(markers);
  return { markers: spread(markers), paths, bounds };
}

/** Stable key for a bounds value, so the map refits only when the set really changes. */
export function boundsKey(b: Bounds | null): string {
  return b ? [b.north, b.south, b.east, b.west].join(',') : '';
}
