// Pure helpers for the timeline view.
import { DateTime, IANAZone } from 'luxon';
import { eventInterval } from '@planfully/shared';
import type { Event, EventType } from '@planfully/shared';

const HOUR_MS = 3_600_000;

/** `tz` if it is a valid IANA zone, else `fallback`. */
export function validZone(tz: string, fallback: string): string {
  return tz && IANAZone.isValidZone(tz) ? tz : fallback;
}

/**
 * Extent of the axis: local midnight (in `tz`) before the earliest start to the midnight after the
 * latest end. null when nothing is scheduled.
 */
export function timelineRange(
  events: readonly Event[],
  tz: string,
): { fromMs: number; toMs: number } | null {
  let first = Infinity;
  let last = -Infinity;
  for (const e of events) {
    const iv = eventInterval(e);
    if (!iv) continue;
    first = Math.min(first, iv.start);
    last = Math.max(last, iv.end);
  }
  if (first === Infinity) return null;
  const from = DateTime.fromMillis(first, { zone: tz }).startOf('day');
  let to = DateTime.fromMillis(last, { zone: tz }).startOf('day').plus({ days: 1 });
  if (to.toMillis() <= last) to = to.plus({ days: 1 });
  return { fromMs: from.toMillis(), toMs: to.toMillis() };
}

/** Round [fromMs, toMs] outward to whole hours. */
export function roundRangeToHours(fromMs: number, toMs: number): { fromMs: number; toMs: number } {
  return {
    fromMs: Math.floor(fromMs / HOUR_MS) * HOUR_MS,
    toMs: Math.ceil(toMs / HOUR_MS) * HOUR_MS,
  };
}

/** Heading for the day containing `ms` in `tz`, e.g. 'Tue Jul 14'. */
export function dayHeading(ms: number, tz: string): string {
  return DateTime.fromMillis(ms, { zone: tz }).toFormat('ccc LLL d');
}

/** The event's own wall-clock start, 'HH:mm' (not converted to the display zone); '' when unscheduled. */
export function localStartLabel(e: Pick<Event, 'start'>): string {
  const local = e.start?.local;
  if (!local) return '';
  const m = /T(\d{2}:\d{2})/.exec(local);
  return m?.[1] ?? '';
}

export const TYPE_ICON: Record<EventType, string> = {
  flight: '✈',
  train: '🚆',
  bus: '🚌',
  ferry: '⛴',
  car: '🚗',
  lodging: '🛏',
  dining: '🍽',
  activity: '🎟',
  attraction: '🏛',
  receipt: '🧾',
  other: '•',
};

/** Hue (0-360) per type; CSS turns it into light and dark block colours. */
export const TYPE_HUE: Record<EventType, number> = {
  flight: 215,
  train: 270,
  bus: 170,
  ferry: 195,
  car: 30,
  lodging: 145,
  dining: 15,
  activity: 330,
  attraction: 50,
  receipt: 90,
  other: 240,
};

/**
 * Scroll anchoring. `anchorMsAt` is the instant at the top of the viewport (the canvas starts
 * `headingPx` below the scroller top); `scrollTopForAnchor` is the scrollTop that puts `anchorMs`
 * back at that same screen y under a different scale (new origin or pxPerHour). Reused by zoom (gy4.7).
 */
export function anchorMsAt(
  scale: { toMs(y: number): number },
  scrollTop: number,
  headingPx: number,
): number {
  return scale.toMs(scrollTop - headingPx);
}

export function scrollTopForAnchor(
  scale: { toY(ms: number): number },
  anchorMs: number,
  headingPx: number,
): number {
  return Math.max(0, scale.toY(anchorMs) + headingPx);
}
