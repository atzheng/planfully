// Pure label helpers for the timeline axis and blocks (zbj.4). Times on blocks are event-local
// wall-clock (never converted); axis labels are in the display zone.
import { DateTime } from 'luxon';
import type { Event } from '@planfully/shared';
import { localStartLabel } from './model';

/** The event's own wall-clock end, 'HH:mm'; '' when it has none. */
export function localEndLabel(e: Pick<Event, 'end'>): string {
  const m = /T(\d{2}:\d{2})/.exec(e.end?.local ?? '');
  return m?.[1] ?? '';
}

/** 'HH:mm–HH:mm', or the start alone when there is no (distinct) end. */
export function localTimeRange(e: Pick<Event, 'start' | 'end'>): string {
  const s = localStartLabel(e);
  const t = localEndLabel(e);
  return s && t && s !== t ? `${s}–${t}` : s;
}

/** The place line for a block: the location name, else the first part of the address. */
export function placeLabel(e: Pick<Event, 'location'>): string {
  const l = e.location;
  return (l?.name ?? l?.address?.split(',')[0] ?? '').trim();
}

/** True when the locale's default clock is 12-hour. */
export function prefers12h(locale?: string): boolean {
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12 === true;
  } catch {
    return true;
  }
}

/** Compact axis hour label: '9a' / '12p' (12-hour) or '14:00' (24-hour), in `tz`. */
export function axisHourLabel(ms: number, tz: string, hour12: boolean): string {
  const dt = DateTime.fromMillis(ms, { zone: tz });
  if (!hour12) return dt.toFormat('HH:mm');
  return `${dt.toFormat('h')}${dt.hour < 12 ? 'a' : 'p'}`;
}

/** Day heading split for emphasis: weekday 'Wed' and the rest '18 Nov'. */
export function dayHeadingParts(ms: number, tz: string): { weekday: string; rest: string } {
  const dt = DateTime.fromMillis(ms, { zone: tz });
  return { weekday: dt.toFormat('ccc'), rest: dt.toFormat('d LLL') };
}
