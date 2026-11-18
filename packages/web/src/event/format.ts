// Pure display helpers for the event sheet.

import { DateTime } from 'luxon';
import {
  toInstant,
  type Event,
  type LocalTime,
  type Location,
  type RosterMember,
} from '@planfully/shared';

/** 'Tue 14 Jul 2026, 09:30 GMT+2' in the event's own zone. */
export function formatLocalTime(t: LocalTime): string {
  const dt = DateTime.fromISO(t.local, { zone: t.tz });
  if (!dt.isValid) return `${t.local} ${t.tz}`;
  return `${dt.toFormat('ccc d LLL yyyy, HH:mm')} ${dt.offsetNameShort ?? t.tz}`;
}

export function formatDuration(start: LocalTime, end: LocalTime): string | null {
  const mins = Math.round((toInstant(end) - toInstant(start)) / 60_000);
  if (!Number.isFinite(mins) || mins <= 0) return null;
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ');
}

export function participantNames(
  e: Pick<Event, 'participants'>,
  roster: readonly RosterMember[],
): string {
  if (e.participants.length === 0) return 'Everyone';
  const names: string[] = [];
  let former = 0;
  for (const id of new Set(e.participants)) {
    const name = roster.find((r) => r.id === id)?.name;
    if (name) names.push(name);
    else former++;
  }
  if (former === 1) names.push('Former participant');
  else if (former > 1) names.push(`${former} former participants`);
  return names.join(', ');
}

export function mapsUrl(loc: Location): string | null {
  const q =
    loc.lat !== undefined && loc.lng !== undefined
      ? `${loc.lat},${loc.lng}`
      : [loc.name, loc.address].filter(Boolean).join(', ');
  if (!q) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/** Only types that cannot run script when opened from a blob: URL on our origin. */
const INLINE_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
export const opensInline = (mime: string) => INLINE_MIMES.has(mime.toLowerCase());

/** The original-email attachment stored by the Worker (.eml, message/rfc822). */
export function isEmailAttachment(a: { mime: string; filename: string }): boolean {
  return a.mime.toLowerCase() === 'message/rfc822' || /\.eml$/i.test(a.filename);
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
