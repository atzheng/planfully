import { DateTime } from 'luxon';
import type { Event } from '@planfully/shared';

export type ZoneOption = {
  /** IANA zone, or '' for the browser zone (the `tz` query value that means "no override"). */
  value: string;
  /** Full label for lists: "Paris (UTC+1)" or "Your time (Europe/Paris)". */
  label: string;
  city: string;
  offset: string;
  isBrowser: boolean;
};

const FALLBACK_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Atlantic/Reykjavik',
  'Europe/London',
  'Europe/Lisbon',
  'Europe/Paris',
  'Europe/Athens',
  'Europe/Istanbul',
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

/** City part of an IANA name: 'America/Argentina/Buenos_Aires' -> 'Buenos Aires'. */
export function cityName(zone: string): string {
  const last = zone.split('/').pop() ?? zone;
  return last.replace(/_/g, ' ');
}

/** 'UTC+1', 'UTC-3:30', 'UTC'. */
export function offsetLabel(zone: string, atMs: number): string {
  const dt = DateTime.fromMillis(atMs, { zone });
  if (!dt.isValid) return 'UTC';
  const min = dt.offset;
  if (min === 0) return 'UTC';
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${min < 0 ? '-' : '+'}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** Compact toolbar text, e.g. 'Paris · UTC+1'. */
export function zoneSummary(zone: string, atMs: number): string {
  return `${cityName(zone)} · ${offsetLabel(zone, atMs)}`;
}

/** The instant used to evaluate offsets: the trip's first start, else `fallbackMs`. */
export function referenceMs(events: readonly Event[], fallbackMs: number): number {
  let first = Infinity;
  for (const e of events) {
    if (!e.start) continue;
    const ms = DateTime.fromISO(e.start.local, { zone: e.start.tz }).toMillis();
    if (Number.isFinite(ms) && ms < first) first = ms;
  }
  return Number.isFinite(first) ? first : fallbackMs;
}

function option(zone: string, atMs: number, browser: boolean): ZoneOption {
  const city = cityName(zone);
  const offset = offsetLabel(zone, atMs);
  return {
    value: browser ? '' : zone,
    label: browser ? `Your time (${zone})` : `${city} (${offset})`,
    city,
    offset,
    isBrowser: browser,
  };
}

/**
 * Zones to offer: the browser zone first, then each distinct zone used by an event's start or end
 * (most used first, ties by first appearance), excluding the browser zone.
 */
export function zoneOptions(
  events: readonly Event[],
  browserZone: string,
  atMs: number = referenceMs(events, Date.now()),
): ZoneOption[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    for (const t of [e.start, e.end]) {
      if (t?.tz && t.tz !== browserZone) counts.set(t.tz, (counts.get(t.tz) ?? 0) + 1);
    }
  }
  const used = [...counts.entries()]
    .map(([zone, n], i) => ({ zone, n, i }))
    .sort((a, b) => b.n - a.n || a.i - b.i);
  return [option(browserZone, atMs, true), ...used.map((u) => option(u.zone, atMs, false))];
}

/** All selectable IANA zones; falls back to a short list where Intl.supportedValuesOf is missing. */
export function allZones(): string[] {
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const list = intl.supportedValuesOf?.('timeZone');
    if (list && list.length > 0) return list.includes('UTC') ? list : ['UTC', ...list];
  } catch {
    // fall through
  }
  return FALLBACK_ZONES;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .trim();

/** Zones whose name contains every word of `query` (underscores and spaces equivalent); city matches first. */
export function searchZones(query: string, zones: readonly string[], limit = 50): string[] {
  const words = norm(query).split(' ').filter(Boolean);
  if (words.length === 0) return [];
  const hits = zones.filter((z) => {
    const n = norm(z.replace(/\//g, ' '));
    return words.every((w) => n.includes(w));
  });
  const rank = (z: string) => (norm(cityName(z)).startsWith(words[0] ?? '') ? 0 : 1);
  return hits
    .map((z, i) => ({ z, i }))
    .sort((a, b) => rank(a.z) - rank(b.z) || a.i - b.i)
    .map((x) => x.z)
    .slice(0, limit);
}
