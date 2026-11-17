// PDF itinerary. buildItinerary is pure; renderPdf loads jsPDF lazily (separate chunk).

import { DateTime } from 'luxon';
import { dayKey, toInstant, type Event, type RosterMember } from '@planfully/shared';
import type { Filter } from '../filters/filter';
import { participantNames } from '../event/format';

export type ItineraryRow = {
  id: string;
  /** '09:30 GMT+2' (zone only when it differs from the previous row); '' when unscheduled */
  time: string;
  name: string;
  type: string;
  confirmation: string;
  location: string;
  participants: string;
  notes: string;
  /** filenames only */
  attachments: string[];
  cancelled: boolean;
};

export type ItineraryDay = { key: string; label: string; rows: ItineraryRow[] };

export type Itinerary = {
  tripName: string;
  /** 'Generated 17 Nov 2026' */
  generated: string;
  /** active filters in words; [] when none */
  filters: string[];
  days: ItineraryDay[];
  unscheduled: ItineraryRow[];
  count: number;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function dateLabel(key: string): string {
  const dt = DateTime.fromISO(key);
  return dt.isValid ? dt.toFormat('cccc d LLLL yyyy') : key;
}

/** Active filters in words, e.g. ['Search: "paris"', 'Types: Flight, Hotel']. */
export function describeFilter(filter: Filter, roster: readonly RosterMember[]): string[] {
  const out: string[] = [];
  if (filter.q.trim()) out.push(`Search: "${filter.q.trim()}"`);
  if (filter.types.length) out.push(`Types: ${filter.types.map(cap).join(', ')}`);
  if (filter.from && filter.to) out.push(`Dates: ${filter.from} to ${filter.to}`);
  else if (filter.from) out.push(`From: ${filter.from}`);
  else if (filter.to) out.push(`Until: ${filter.to}`);
  if (filter.who.length) {
    const names = filter.who.map(
      (id) => roster.find((r) => r.id === id)?.name ?? 'Former participant',
    );
    out.push(`Participants: ${names.join(', ')}`);
  }
  if (filter.cancelled) out.push('Including cancelled events');
  return out;
}

function zoneAbbr(t: { local: string; tz: string }): string {
  const dt = DateTime.fromISO(t.local, { zone: t.tz });
  return dt.isValid ? (dt.offsetNameShort ?? t.tz) : t.tz;
}

function locationText(e: Event): string {
  const one = (l: NonNullable<Event['location']>) => [l.name, l.address].filter(Boolean).join(', ');
  const a = e.location ? one(e.location) : '';
  const b = e.endLocation ? one(e.endLocation) : '';
  if (a && b && a !== b) return `${a} -> ${b}`;
  return a || b;
}

function timeText(e: Event, prevTz: string | null): string {
  const s = e.start;
  if (!s) return '';
  let text = s.local.slice(11, 16);
  if (prevTz !== s.tz) text += ` ${zoneAbbr(s)}`;
  const end = e.end;
  if (end && end.local !== s.local) {
    const endZone = end.tz !== s.tz ? ` ${zoneAbbr(end)}` : '';
    const endTime = end.local.slice(11, 16);
    if (dayKey(end) === dayKey(s)) text += ` - ${endTime}${endZone}`;
    else {
      const d = DateTime.fromISO(dayKey(end));
      text += ` - ${d.isValid ? d.toFormat('ccc d LLL') : dayKey(end)} ${endTime}${endZone}`;
    }
  }
  return text;
}

function row(e: Event, roster: readonly RosterMember[], time: string): ItineraryRow {
  return {
    id: e.id,
    time,
    name: e.status === 'cancelled' ? `${e.name} (cancelled)` : e.name,
    type: cap(e.type),
    confirmation: e.confirmation ?? '',
    location: locationText(e),
    participants: participantNames(e, roster),
    notes: e.notes?.trim() ?? '',
    attachments: e.attachments.map((a) => a.filename),
    cancelled: e.status === 'cancelled',
  };
}

/** Pure: events (as filtered on screen) -> days of rows, plus an unscheduled list. */
export function buildItinerary(
  events: readonly Event[],
  roster: readonly RosterMember[],
  filter: Filter,
  meta: { tripName: string; now?: Date } = { tripName: 'Trip' },
): Itinerary {
  const scheduled: { e: Event; ms: number }[] = [];
  const unscheduledEvents: Event[] = [];
  for (const e of events) {
    let ms: number | null = null;
    if (e.start) {
      try {
        ms = toInstant(e.start);
      } catch {
        ms = null;
      }
    }
    if (ms === null) unscheduledEvents.push(e);
    else scheduled.push({ e, ms });
  }
  // Group by the event's own local date; days by date string, rows within a day by instant.
  const byDay = new Map<string, { e: Event; ms: number }[]>();
  for (const item of scheduled) {
    const key = item.e.start ? dayKey(item.e.start) : '';
    const list = byDay.get(key);
    if (list) list.push(item);
    else byDay.set(key, [item]);
  }
  const days: ItineraryDay[] = [];
  let prevTz: string | null = null;
  for (const key of [...byDay.keys()].sort()) {
    const items = (byDay.get(key) ?? []).sort(
      (a, b) => a.ms - b.ms || a.e.name.localeCompare(b.e.name),
    );
    const rows: ItineraryRow[] = [];
    for (const { e } of items) {
      rows.push(row(e, roster, timeText(e, prevTz)));
      prevTz = e.start?.tz ?? prevTz;
    }
    days.push({ key, label: dateLabel(key), rows });
  }
  const unscheduled = unscheduledEvents
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => row(e, roster, ''));

  const now = meta.now ?? new Date();
  return {
    tripName: meta.tripName,
    generated: `Generated ${DateTime.fromJSDate(now).toFormat('d LLL yyyy')}`,
    filters: describeFilter(filter, roster),
    days,
    unscheduled,
    count: events.length,
  };
}

/** '<slug of trip name><suffix>' (slug capped at 80 chars; 'trip' when empty). */
export function exportFileName(tripName: string, suffix: string): string {
  const slug = tripName
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase();
  return `${slug.slice(0, 80).replace(/-+$/, '') || 'trip'}${suffix}`;
}

export function pdfFileName(tripName: string): string {
  return exportFileName(tripName, '-itinerary.pdf');
}

/**
 * jsPDF's built-in fonts only cover WinAnsi (Latin). Anything else would print as garbage,
 * so replace it with '?'. Known limitation: no embedded Unicode font yet.
 */
export function latinSafe(s: string): string {
  return s.replace(
    // eslint-disable-next-line no-control-regex
    /[^\x09\x0A\x20-\x7E\xA0-\xFF–—‘’“”•…€]/gu,
    '?',
  );
}

/** Builds and downloads the PDF. Loads jsPDF and autotable on first use. */
export async function renderPdf(it: Itinerary): Promise<void> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 40;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const t = latinSafe;

  let y = margin + 14;
  doc.setFont('helvetica', 'bold').setFontSize(18).text(t(it.tripName), margin, y);
  y += 16;
  doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(90);
  doc.text(t(`${it.generated}. ${it.count} ${it.count === 1 ? 'event' : 'events'}.`), margin, y);
  y += 12;
  const filterLine = it.filters.length
    ? `Filters: ${it.filters.join('; ')}`
    : 'Filters: none (all events)';
  const lines = doc.splitTextToSize(t(filterLine), pageW - margin * 2) as string[];
  doc.text(lines, margin, y);
  y += lines.length * 11 + 8;
  doc.setTextColor(0);

  // Notes and filenames live in the event cell so a row (and its notes) never splits across pages.
  const cell = (r: ItineraryRow) => {
    const extra = [r.notes, r.attachments.length ? `Files: ${r.attachments.join(', ')}` : '']
      .filter(Boolean)
      .join('\n');
    return t(extra ? `${r.name}\n${extra}` : r.name);
  };
  const columns = ['Time', 'Event', 'Type', 'Confirmation', 'Location', 'Who'];
  const section = (title: string, rows: ItineraryRow[]) => {
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin, bottom: margin + 10 },
      head: [[{ content: t(title), colSpan: columns.length }], columns],
      body: rows.map((r) => [
        t(r.time),
        cell(r),
        t(r.type),
        t(r.confirmation),
        t(r.location),
        t(r.participants),
      ]),
      showHead: 'everyPage',
      rowPageBreak: 'avoid',
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: 4, overflow: 'linebreak' },
      headStyles: { fillColor: [90, 90, 90], textColor: 255 },
      // Fixed widths so every day's table lines up (A4 content width is 515pt).
      columnStyles: {
        0: { cellWidth: 78 },
        1: { cellWidth: 140 },
        2: { cellWidth: 48 },
        3: { cellWidth: 66 },
        4: { cellWidth: 113 },
        5: { cellWidth: 70 },
      },
      didParseCell: (d) => {
        if (d.section === 'head' && d.row.index === 0) {
          d.cell.styles.fillColor = [42, 91, 215];
          d.cell.styles.fontSize = 11;
        }
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lastAutoTable is added by the plugin
    y = ((doc as any).lastAutoTable.finalY as number) + 14;
  };
  for (const d of it.days) section(d.label, d.rows);
  if (it.unscheduled.length) section('Unscheduled', it.unscheduled);
  if (it.count === 0) doc.text('No events match the current filters.', margin, y);

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8).setTextColor(120);
    doc.text(`Page ${i} of ${pages}`, pageW - margin, pageH - 20, { align: 'right' });
  }
  doc.save(pdfFileName(it.tripName));
}
