import { eventInterval } from '@planfully/shared';
import type { Event, Location } from '@planfully/shared';

export const HOUR_MS = 3_600_000;

export type WeatherSegment = {
  fromMs: number;
  toMs: number;
  lat: number;
  lng: number;
  label: string;
};

type Placed = { start: number; end: number; lat: number; lng: number; label: string };

const round2 = (n: number) => Math.round(n * 100) / 100;

function point(loc: Location | undefined): { lat: number; lng: number; label: string } | null {
  if (!loc || loc.lat === undefined || loc.lng === undefined) return null;
  return { lat: loc.lat, lng: loc.lng, label: loc.name ?? loc.address ?? '' };
}

function placed(events: readonly Event[]): Placed[] {
  const out: Placed[] = [];
  for (const e of events) {
    if (e.deleted || e.status === 'cancelled') continue;
    const iv = eventInterval(e);
    if (!iv) continue;
    // Transport: the arrival point stands for the whole event (and afterwards).
    const p = point(e.endLocation) ?? point(e.location);
    if (!p) continue;
    out.push({ start: iv.start, end: Math.max(iv.start, iv.end), ...p });
  }
  return out;
}

/**
 * Location for each whole hour in [fromMs, toMs), merged into segments of consecutive hours at the
 * same place (lat/lng rounded to 2 decimals). Hours start at floor(fromMs / hour).
 * Locations are sampled at each hour's start (an event starting mid-hour takes effect the next hour).
 * The first and last segments are clamped to [fromMs, toMs).
 * Per hour (evaluated at the hour's start): the located event in progress (latest start wins); else
 * the most recent located event that has ended; else the first upcoming located event.
 * Cancelled, deleted and unscheduled events, and events without coordinates, are ignored.
 */
export function hourlyLocations(
  events: readonly Event[],
  fromMs: number,
  toMs: number,
): WeatherSegment[] {
  const items = placed(events);
  if (items.length === 0 || toMs <= fromMs) return [];
  const segs: WeatherSegment[] = [];
  const first = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
  for (let h = first; h < toMs; h += HOUR_MS) {
    let pick: Placed | undefined;
    for (const p of items) {
      if (p.start <= h && h < p.end && (!pick || p.start >= pick.start)) pick = p;
    }
    if (!pick) {
      for (const p of items) {
        if (p.end <= h && (!pick || p.end >= pick.end)) pick = p;
      }
    }
    if (!pick) {
      for (const p of items) {
        if (p.start > h && (!pick || p.start < pick.start)) pick = p;
      }
    }
    if (!pick) continue;
    const lat = round2(pick.lat);
    const lng = round2(pick.lng);
    const last = segs[segs.length - 1];
    if (last && last.toMs === h && last.lat === lat && last.lng === lng) last.toMs = h + HOUR_MS;
    else segs.push({ fromMs: h, toMs: h + HOUR_MS, lat, lng, label: pick.label });
  }
  const head = segs[0];
  if (head) head.fromMs = Math.max(head.fromMs, fromMs);
  const tail = segs[segs.length - 1];
  if (tail) tail.toMs = Math.min(tail.toMs, toMs);
  return segs;
}
