// PDF itinerary. buildItinerary is pure; renderPdf loads jsPDF lazily (separate chunk).

import { DateTime } from 'luxon';
import {
  dayKey,
  localTimeAbbreviation,
  toInstant,
  type Event,
  type RosterMember,
} from '@planfully/shared';
import type { Filter } from '../filters/filter';
import { participantNames } from '../event/format';
import { eventKindLabel } from '../timeline/model';
import {
  chooseFont,
  coverageFor,
  detectScripts,
  loadFontBase64,
  maskRtl,
  type FontChoice,
  type RtlScript,
  sanitize,
  type FontLoader,
} from './fonts';

export type ItineraryRow = {
  id: string;
  /** '09:30 CEST' (zone only when it differs from the previous row); '' when unscheduled */
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
  if (filter.excludeTypes?.length)
    out.push(`Excluding types: ${filter.excludeTypes.map(cap).join(', ')}`);
  if (filter.from && filter.to) out.push(`Dates: ${filter.from} to ${filter.to}`);
  else if (filter.from) out.push(`From: ${filter.from}`);
  else if (filter.to) out.push(`Until: ${filter.to}`);
  if (filter.who.length) {
    const names = filter.who.map(
      (id) => roster.find((r) => r.id === id)?.name ?? 'Former participant',
    );
    out.push(`Participants: ${names.join(', ')}`);
  }
  if (filter.excludeWho?.length) {
    const names = filter.excludeWho.map(
      (id) => roster.find((r) => r.id === id)?.name ?? 'Former participant',
    );
    out.push(`Excluding participants: ${names.join(', ')}`);
  }
  if (filter.cancelled) out.push('Including cancelled events');
  return out;
}

function zoneAbbr(t: { local: string; tz: string }): string {
  try {
    return localTimeAbbreviation(t);
  } catch {
    return t.tz;
  }
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
    type: cap(eventKindLabel(e)),
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
 * jsPDF's built-in fonts only cover WinAnsi (Latin); anything else would print as garbage, so it
 * becomes '?'. renderPdf swaps in a Unicode font (see fonts.ts) when the itinerary needs one.
 */
export function latinSafe(s: string): string {
  return sanitize(s, null);
}

/** Every string that ends up on the page. */
export function itineraryText(it: Itinerary): string {
  const rows = [...it.days.flatMap((d) => d.rows), ...it.unscheduled];
  return [
    it.tripName,
    it.generated,
    ...it.filters,
    ...it.days.map((d) => d.label),
    ...rows.flatMap((r) => [
      r.time,
      r.name,
      r.type,
      r.confirmation,
      r.location,
      r.participants,
      r.notes,
      ...r.attachments,
    ]),
  ].join('\n');
}

export type RenderDeps = {
  /** Fetches a font file as base64. Defaults to /fonts/<file> on our own origin. */
  loadFont?: FontLoader;
  /** Defaults to doc.save(fileName). */
  save?: (doc: import('jspdf').jsPDF, fileName: string) => void;
};

export type RenderResult = {
  /** Scripts the PDF cannot draw (replaced by a '[Arabic text]' placeholder); [] normally. */
  unsupported: RtlScript[];
};

/**
 * Plans the fonts for a document: every distinct string is masked (Arabic/Hebrew), assigned the
 * font its own scripts need, and the set of fonts to embed is returned. Pure apart from the
 * lazily imported coverage table.
 */
export async function planFonts(texts: readonly string[]): Promise<{
  choices: FontChoice[];
  unsupported: RtlScript[];
  /** Masked, sanitised text and the font family to draw it in ('helvetica' = built-in). */
  prepare: (s: string) => { text: string; family: string };
}> {
  const masked = new Map<string, string>();
  const found = new Set<RtlScript>();
  const byFamily = new Map<string, FontChoice>();
  const choiceOf = new Map<string, FontChoice | null>();
  // A Japanese itinerary has kanji-only cells too: they must use the Japanese glyph forms.
  const docHasKana = texts.some((t) => detectScripts(maskRtl(t).text).has('kana'));
  for (const raw of texts) {
    if (masked.has(raw)) continue;
    const m = maskRtl(raw);
    m.found.forEach((f) => found.add(f));
    masked.set(raw, m.text);
    const choice = chooseFont(detectScripts(m.text), docHasKana);
    choiceOf.set(raw, choice);
    if (choice) byFamily.set(choice.family, choice);
  }
  const coverage = new Map<string, (cp: number) => boolean>();
  for (const c of byFamily.values()) coverage.set(c.family, await coverageFor(c));
  return {
    choices: [...byFamily.values()],
    unsupported: [...found].sort(),
    prepare: (raw) => {
      const m = masked.get(raw) ?? maskRtl(raw).text;
      const choice = choiceOf.get(raw) ?? chooseFont(detectScripts(m), docHasKana);
      const covers = choice ? (coverage.get(choice.family) ?? null) : null;
      return { text: sanitize(m, covers), family: choice?.family ?? 'helvetica' };
    },
  };
}

/** Builds and downloads the PDF. Loads jsPDF and autotable on first use. */
export async function renderPdf(it: Itinerary, deps: RenderDeps = {}): Promise<RenderResult> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const margin = 40;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  // Each cell (and heading) gets the font its own text needs, so a mixed itinerary can have Latin,
  // Japanese and Korean rows in one PDF. Fonts are fetched only for the scripts present.
  const NOTICE_FOR = (u: RtlScript[]) =>
    `Text in ${u.join(' and ')} cannot be shown in this PDF and appears as a placeholder, e.g. [${u[0]} text].`;
  const rowsAll = [...it.days.flatMap((d) => d.rows), ...it.unscheduled];
  const cellText = (r: ItineraryRow) => {
    const extra = [r.notes, r.attachments.length ? `Files: ${r.attachments.join(', ')}` : '']
      .filter(Boolean)
      .join('\n');
    return extra ? `${r.name}\n${extra}` : r.name;
  };
  const filterLine = it.filters.length
    ? `Filters: ${it.filters.join('; ')}`
    : 'Filters: none (all events)';
  const texts = [
    it.tripName,
    `${it.generated}. ${it.count} ${it.count === 1 ? 'event' : 'events'}.`,
    filterLine,
    ...it.days.map((d) => d.label),
    ...rowsAll.flatMap((r) => [
      r.time,
      cellText(r),
      r.type,
      r.confirmation,
      r.location,
      r.participants,
    ]),
  ];
  const plan = await planFonts(texts);
  const load = deps.loadFont ?? loadFontBase64;
  const loaded = new Map<string, string>();
  for (const choice of plan.choices) {
    for (const face of choice.faces) {
      if (!loaded.has(face.file)) loaded.set(face.file, await load(face.file));
    }
  }
  for (const choice of plan.choices) {
    for (const face of choice.faces) {
      const vfsName = `${choice.family}-${face.style}-${face.file}`;
      doc.addFileToVFS(vfsName, loaded.get(face.file) ?? '');
      doc.addFont(vfsName, choice.family, face.style);
    }
  }
  const t = (s: string) => plan.prepare(s).text;
  const fam = (s: string) => plan.prepare(s).family;
  const cellOf = (s: string) => {
    const p = plan.prepare(s);
    return { content: p.text, styles: { font: p.family } };
  };

  let y = margin + 14;
  doc.setFont(fam(it.tripName), 'bold').setFontSize(18).text(t(it.tripName), margin, y);
  y += 16;
  const gen = `${it.generated}. ${it.count} ${it.count === 1 ? 'event' : 'events'}.`;
  doc.setFont(fam(gen), 'normal').setFontSize(9).setTextColor(90);
  doc.text(t(gen), margin, y);
  y += 12;
  doc.setFont(fam(filterLine), 'normal');
  const lines = doc.splitTextToSize(t(filterLine), pageW - margin * 2) as string[];
  doc.text(lines, margin, y);
  y += lines.length * 11 + 8;
  if (plan.unsupported.length) {
    doc.setFont('helvetica', 'normal').setTextColor(160, 40, 40);
    const note = doc.splitTextToSize(NOTICE_FOR(plan.unsupported), pageW - margin * 2) as string[];
    doc.text(note, margin, y);
    y += note.length * 11 + 8;
  }
  doc.setTextColor(0);

  // Notes and filenames live in the event cell so a row (and its notes) never splits across pages.
  const columns = ['Time', 'Event', 'Type', 'Confirmation', 'Location', 'Who'];
  const section = (title: string, rows: ItineraryRow[]) => {
    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin, bottom: margin + 10 },
      head: [[{ ...cellOf(title), colSpan: columns.length }], columns],
      body: rows.map((r) => [
        cellOf(r.time),
        cellOf(cellText(r)),
        cellOf(r.type),
        cellOf(r.confirmation),
        cellOf(r.location),
        cellOf(r.participants),
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
  (deps.save ?? ((d, name) => d.save(name)))(doc, pdfFileName(it.tripName));
  return { unsupported: plan.unsupported };
}
