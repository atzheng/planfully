import { DateTime } from 'luxon';
import type { Event, LocalTime } from './schema';

function toDateTime(t: LocalTime): DateTime {
  // Nonexistent local times (spring-forward gap) are resolved by luxon: shifted forward by the gap
  // (02:30 -> 03:30). Ambiguous times (fall-back overlap) resolve to the later, standard-time occurrence.
  const dt = DateTime.fromISO(t.local, { zone: t.tz });
  if (!dt.isValid) throw new Error(`invalid local time: ${t.local} ${t.tz}`);
  return dt;
}

/** Epoch ms of a local time in its zone. */
export function toInstant(t: LocalTime): number {
  return toDateTime(t).toMillis();
}

export function fromInstant(ms: number, tz: string): LocalTime {
  const dt = DateTime.fromMillis(ms, { zone: tz });
  if (!dt.isValid) throw new Error(`invalid zone: ${tz}`);
  return { local: dt.toFormat("yyyy-MM-dd'T'HH:mm"), tz };
}

/** 'YYYY-MM-DD' in the time's own zone. */
export function dayKey(t: LocalTime): string {
  return t.local.slice(0, 10);
}

/** Absolute interval of a scheduled event; null when unscheduled. `end` defaults to `start`. */
export function eventInterval(
  e: Pick<Event, 'start' | 'end'>,
): { start: number; end: number } | null {
  if (!e.start) return null;
  const start = toInstant(e.start);
  return { start, end: e.end ? toInstant(e.end) : start };
}
