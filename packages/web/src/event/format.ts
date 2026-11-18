// Pure display helpers for the event sheet.

import { DateTime } from 'luxon';
import {
  localTimeAbbreviation,
  toInstant,
  type Event,
  type LocalTime,
  type Location,
  type RosterMember,
} from '@planfully/shared';

/** 'Tue 14 Jul 2026, 09:30 CEST' in the event's own zone. */
export function formatLocalTime(t: LocalTime): string {
  const dt = DateTime.fromISO(t.local, { zone: t.tz });
  if (!dt.isValid) return `${t.local} ${t.tz}`;
  return `${dt.toFormat('ccc d LLL yyyy, HH:mm')} ${localTimeAbbreviation(t)}`;
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

const startsWith = (b: Uint8Array, sig: number[], at = 0) =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** Bytes needed by `matchesMagic`. */
export const MAGIC_BYTES = 12;

/**
 * Defence in depth before opening a blob inline: does the content start with the signature of the
 * claimed type? False means download instead. Types without a signature check return false.
 */
export function matchesMagic(mime: string, head: Uint8Array): boolean {
  switch (mime.toLowerCase()) {
    case 'application/pdf': {
      // Readers tolerate a few junk bytes before the header; allow up to 1 KB like the PDF spec.
      const sig = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
      for (let i = 0; i + sig.length <= Math.min(head.length, 1024); i++) {
        if (startsWith(head, sig, i)) return true;
      }
      return false;
    }
    case 'image/png':
      return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(head, [0xff, 0xd8, 0xff]);
    case 'image/gif':
      return startsWith(head, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39);
    case 'image/webp':
      return (
        startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)
      );
    default:
      return false;
  }
}

/** Sync variant for bytes already in memory. */
export function canOpenInlineBytes(bytes: Uint8Array, mime: string): boolean {
  return opensInline(mime) && matchesMagic(mime, bytes.subarray(0, 1024));
}

/** Whether a blob may be opened inline: allowlisted type AND matching signature. */
export async function canOpenInline(blob: Blob, mime: string): Promise<boolean> {
  if (!opensInline(mime)) return false;
  // PDF check scans up to 1 KB, so read a bit more than MAGIC_BYTES.
  const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
  return matchesMagic(mime, head);
}

/** The original-email attachment stored by the Worker (.eml, message/rfc822). */
export function isEmailAttachment(a: { mime: string; filename: string }): boolean {
  return a.mime.toLowerCase() === 'message/rfc822' || /\.eml$/i.test(a.filename);
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
