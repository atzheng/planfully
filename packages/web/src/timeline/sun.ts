// Day/night bands for the timeline background (planfully-5xa). Pure: no network, no React.
// Sun times use the standard sunrise equation (NOAA-style approximation, accurate to about a minute
// at non-polar latitudes), which is plenty for background shading.
import type { WeatherSegment } from '../weather/resolve';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const J2000 = 2_451_545;
const UNIX_EPOCH_JD = 2_440_587.5;
const RAD = Math.PI / 180;
/** Sun centre 0.833° below the horizon: refraction plus the solar radius. */
const HORIZON = -0.833 * RAD;
const OBLIQUITY = 23.4397 * RAD;

const toJd = (ms: number) => ms / DAY_MS + UNIX_EPOCH_JD;
const fromJd = (jd: number) => (jd - UNIX_EPOCH_JD) * DAY_MS;

export type SunDay =
  | { kind: 'normal'; transitMs: number; riseMs: number; setMs: number }
  | { kind: 'polar-day'; transitMs: number }
  | { kind: 'polar-night'; transitMs: number };

/** Sun times for solar day `n` (days since J2000 at the given longitude). `lng` is east-positive. */
export function sunDay(n: number, lat: number, lng: number): SunDay {
  const jStar = n - lng / 360;
  const m = ((357.5291 + 0.98560028 * jStar) % 360) * RAD;
  const c = 1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m);
  const lambda = (((m / RAD + c + 180 + 102.9372) % 360) + 360) % 360;
  const l = lambda * RAD;
  const transit = J2000 + jStar + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l);
  const sinDec = Math.sin(l) * Math.sin(OBLIQUITY);
  const cosDec = Math.cos(Math.asin(sinDec));
  const phi = lat * RAD;
  const cosW = (Math.sin(HORIZON) - Math.sin(phi) * sinDec) / (Math.cos(phi) * cosDec);
  const transitMs = fromJd(transit);
  if (cosW > 1) return { kind: 'polar-night', transitMs };
  if (cosW < -1) return { kind: 'polar-day', transitMs };
  const halfDay = (Math.acos(cosW) / (2 * Math.PI)) * DAY_MS;
  return { kind: 'normal', transitMs, riseMs: transitMs - halfDay, setMs: transitMs + halfDay };
}

/** Sun days whose transit is within a day of [fromMs, toMs), in order. */
export function sunDays(lat: number, lng: number, fromMs: number, toMs: number): SunDay[] {
  const first = Math.floor(toJd(fromMs) - J2000) - 1;
  const last = Math.ceil(toJd(toMs) - J2000) + 1;
  const out: SunDay[] = [];
  for (let n = first; n <= last; n++) out.push(sunDay(n, lat, lng));
  return out;
}

export type Interval = { fromMs: number; toMs: number };
export type SunMark = { ms: number; kind: 'rise' | 'set' };
export type DayNight = { nights: Interval[]; marks: SunMark[] };

/**
 * Night bands and sunrise/sunset marks for location segments (from hourlyLocations). Each segment
 * uses its own place's sun; nights are clipped to their segment and adjacent bands are merged.
 * Marks are the rises and sets strictly inside a segment. Polar day has no night; polar night is
 * one long night.
 */
export function dayNight(segments: readonly WeatherSegment[]): DayNight {
  const nights: Interval[] = [];
  const marks: SunMark[] = [];
  const pushNight = (fromMs: number, toMs: number) => {
    if (!(toMs > fromMs)) return;
    const prev = nights[nights.length - 1];
    if (prev && prev.toMs >= fromMs) prev.toMs = Math.max(prev.toMs, toMs);
    else nights.push({ fromMs, toMs });
  };
  for (const seg of segments) {
    const days: Interval[] = [];
    for (const d of sunDays(seg.lat, seg.lng, seg.fromMs, seg.toMs)) {
      if (d.kind === 'normal') {
        days.push({ fromMs: d.riseMs, toMs: d.setMs });
        if (d.riseMs > seg.fromMs && d.riseMs < seg.toMs)
          marks.push({ ms: d.riseMs, kind: 'rise' });
        if (d.setMs > seg.fromMs && d.setMs < seg.toMs) marks.push({ ms: d.setMs, kind: 'set' });
      } else if (d.kind === 'polar-day') {
        // Slightly over half a day each side: transits are not exactly 24 h apart.
        days.push({ fromMs: d.transitMs - 13 * HOUR_MS, toMs: d.transitMs + 13 * HOUR_MS });
      }
    }
    // Night = the segment minus the union of daylight intervals.
    let cursor = seg.fromMs;
    for (const day of days) {
      if (day.toMs <= cursor) continue;
      if (day.fromMs >= seg.toMs) break;
      pushNight(cursor, Math.min(day.fromMs, seg.toMs));
      cursor = Math.max(cursor, day.toMs);
    }
    pushNight(cursor, seg.toMs);
  }
  marks.sort((a, b) => a.ms - b.ms);
  return { nights, marks };
}
