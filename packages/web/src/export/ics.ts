// Calendar (.ics) export. Pure string generation per RFC 5545; no dependency.
// Times are written as UTC instants so no VTIMEZONE definitions are needed.

import { toInstant, type Event, type Location, type RosterMember } from '@planfully/shared';
import { participantNames } from '../event/format';
import { exportFileName } from './pdf';

const HOUR_MS = 3_600_000;
const enc = new TextEncoder();

/** Escapes TEXT values: backslash, semicolon, comma, newlines. */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Folds a content line at 75 octets (not characters), never splitting a UTF-8 sequence. */
export function foldLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curBytes + n > 75) {
      out.push(cur);
      cur = ' ';
      curBytes = 1;
    }
    cur += ch;
    curBytes += n;
  }
  out.push(cur);
  return out;
}

/** 20260714T093000Z */
function utc(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

function locationText(loc: Location | undefined): string {
  return [loc?.name, loc?.address].filter(Boolean).join(', ');
}

export function buildIcs(
  events: readonly Event[],
  tripName: string,
  roster: readonly RosterMember[] = [],
  now: Date = new Date(),
): string {
  const lines: string[] = [];
  const add = (l: string) => lines.push(...foldLine(l));
  add('BEGIN:VCALENDAR');
  add('VERSION:2.0');
  add('PRODID:-//Planfully//Trip export//EN');
  add('CALSCALE:GREGORIAN');
  add('METHOD:PUBLISH');
  add(`X-WR-CALNAME:${escapeText(tripName)}`);
  const stamp = utc(now.getTime());
  for (const e of events) {
    if (!e.start || e.deleted) continue;
    const start = toInstant(e.start);
    const end = e.end ? Math.max(toInstant(e.end), start) : start + HOUR_MS;
    add('BEGIN:VEVENT');
    add(`UID:${e.id}@planfully`);
    add(`DTSTAMP:${stamp}`);
    add(`DTSTART:${utc(start)}`);
    add(`DTEND:${utc(end)}`);
    add(`SUMMARY:${escapeText(e.name)}`);
    const where = locationText(e.location);
    if (where) add(`LOCATION:${escapeText(where)}`);
    if (e.location?.lat !== undefined && e.location.lng !== undefined) {
      add(`GEO:${e.location.lat};${e.location.lng}`);
    }
    const desc: string[] = [];
    if (e.confirmation) desc.push(`Confirmation: ${e.confirmation}`);
    const to = locationText(e.endLocation);
    if (to) desc.push(`To: ${to}`);
    desc.push(`Participants: ${participantNames(e, roster)}`);
    if (e.notes) desc.push(e.notes);
    add(`DESCRIPTION:${escapeText(desc.join('\n'))}`);
    if (e.status === 'cancelled') add('STATUS:CANCELLED');
    add('END:VEVENT');
  }
  add('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export const icsFileName = (tripName: string) => exportFileName(tripName, '.ics');

/** Builds the calendar and downloads it. */
export function downloadIcs(
  events: readonly Event[],
  tripName: string,
  roster: readonly RosterMember[],
): void {
  const blob = new Blob([buildIcs(events, tripName, roster)], {
    type: 'text/calendar;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = icsFileName(tripName);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
