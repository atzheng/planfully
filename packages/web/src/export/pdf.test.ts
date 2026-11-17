import { describe, expect, it } from 'vitest';
import type { Event, RosterMember } from '@planfully/shared';
import type { Filter } from '../filters/filter';
import { buildItinerary, describeFilter, latinSafe, pdfFileName } from './pdf';

const NO_FILTER: Filter = { q: '', types: [], who: [], cancelled: false };
const roster: RosterMember[] = [
  { id: 'a', name: 'Ann', aliases: [] },
  { id: 'b', name: 'Bob', aliases: [] },
];
const ev = (o: Partial<Event> & { id: string }): Event => ({
  name: o.id,
  type: 'activity',
  attachments: [],
  participants: [],
  status: 'confirmed',
  source: 'manual',
  createdAt: '2026-01-01T00:00:00Z',
  ...o,
});
const at = (local: string, tz = 'Europe/Paris') => ({ local, tz });

describe('buildItinerary', () => {
  it('groups by local start day, sorted by instant', () => {
    const it = buildItinerary(
      [
        ev({ id: 'late', start: at('2026-07-14T20:00') }),
        ev({ id: 'next', start: at('2026-07-15T08:00') }),
        ev({ id: 'early', start: at('2026-07-14T09:30') }),
      ],
      roster,
      NO_FILTER,
    );
    expect(it.days.map((d) => d.key)).toEqual(['2026-07-14', '2026-07-15']);
    expect(it.days[0]?.rows.map((r) => r.name)).toEqual(['early', 'late']);
    expect(it.days[0]?.label).toBe('Tuesday 14 July 2026');
    expect(it.count).toBe(3);
  });

  it('shows the zone only when it differs from the previous row', () => {
    const it = buildItinerary(
      [
        ev({ id: '1', start: at('2026-07-14T08:00', 'Europe/Paris') }),
        ev({ id: '2', start: at('2026-07-14T12:00', 'Europe/Paris') }),
        ev({ id: '3', start: at('2026-07-14T18:00', 'America/New_York') }),
      ],
      roster,
      NO_FILTER,
    );
    const rows = it.days[0]?.rows ?? [];
    expect(rows[0]?.time).toBe('08:00 GMT+2');
    expect(rows[1]?.time).toBe('12:00');
    expect(rows[2]?.time).toBe('18:00 EDT');
  });

  it('lists multi-day events on their first day with the end date', () => {
    const it = buildItinerary(
      [
        ev({
          id: 'stay',
          type: 'lodging',
          start: at('2026-07-14T15:00'),
          end: at('2026-07-17T11:00'),
        }),
      ],
      roster,
      NO_FILTER,
    );
    expect(it.days).toHaveLength(1);
    expect(it.days[0]?.rows[0]?.time).toBe('15:00 GMT+2 - Fri 17 Jul 11:00');
    expect(it.days[0]?.rows[0]?.type).toBe('Lodging');
  });

  it('puts unscheduled events last and keeps details', () => {
    const it = buildItinerary(
      [
        ev({
          id: 'x',
          name: 'Visa',
          notes: ' bring passport ',
          confirmation: 'ABC',
          participants: ['a'],
          attachments: [
            { id: '1', filename: 'visa.pdf', mime: 'application/pdf', size: 1, kind: 'file' },
          ],
        }),
        ev({ id: 'y', start: at('2026-07-14T09:00') }),
      ],
      roster,
      NO_FILTER,
    );
    expect(it.days).toHaveLength(1);
    expect(it.unscheduled).toHaveLength(1);
    const r = it.unscheduled[0];
    expect(r).toMatchObject({
      name: 'Visa',
      time: '',
      notes: 'bring passport',
      confirmation: 'ABC',
      participants: 'Ann',
      attachments: ['visa.pdf'],
    });
  });

  it('marks cancelled events and joins transport locations', () => {
    const it = buildItinerary(
      [
        ev({
          id: 'f',
          name: 'Flight',
          type: 'flight',
          status: 'cancelled',
          start: at('2026-07-14T09:00'),
          location: { name: 'CDG' },
          endLocation: { name: 'JFK' },
        }),
      ],
      roster,
      NO_FILTER,
    );
    expect(it.days[0]?.rows[0]).toMatchObject({
      name: 'Flight (cancelled)',
      location: 'CDG -> JFK',
      cancelled: true,
      participants: 'Everyone',
    });
  });

  it('handles an empty list', () => {
    const it = buildItinerary([], roster, NO_FILTER, {
      tripName: 'T',
      now: new Date(2026, 10, 17),
    });
    expect(it).toMatchObject({
      days: [],
      unscheduled: [],
      count: 0,
      filters: [],
      generated: 'Generated 17 Nov 2026',
    });
  });
});

describe('buildItinerary across zones', () => {
  it('orders days by local date and rows by instant, with no repeated day', () => {
    const it = buildItinerary(
      [
        ev({ id: 'tokyo-early', start: at('2026-03-02T01:00', 'Asia/Tokyo') }),
        ev({ id: 'ny', start: at('2026-03-01T20:00', 'America/New_York') }),
        ev({ id: 'tokyo-late', start: at('2026-03-02T09:00', 'Asia/Tokyo') }),
      ],
      roster,
      NO_FILTER,
    );
    expect(it.days.map((d) => d.key)).toEqual(['2026-03-01', '2026-03-02']);
    expect(it.days[1]?.rows.map((r) => r.name)).toEqual(['tokyo-early', 'tokyo-late']);
  });
});

describe('describeFilter', () => {
  it('is empty when nothing is active', () => {
    expect(describeFilter(NO_FILTER, roster)).toEqual([]);
  });
  it('describes every criterion in words', () => {
    expect(
      describeFilter(
        {
          q: ' paris ',
          types: ['flight', 'lodging'],
          from: '2026-07-01',
          to: '2026-07-10',
          who: ['b', 'zz'],
          cancelled: true,
        },
        roster,
      ),
    ).toEqual([
      'Search: "paris"',
      'Types: Flight, Lodging',
      'Dates: 2026-07-01 to 2026-07-10',
      'Participants: Bob, Former participant',
      'Including cancelled events',
    ]);
    expect(describeFilter({ ...NO_FILTER, from: '2026-07-01' }, roster)).toEqual([
      'From: 2026-07-01',
    ]);
    expect(describeFilter({ ...NO_FILTER, to: '2026-07-01' }, roster)).toEqual([
      'Until: 2026-07-01',
    ]);
  });
});

describe('helpers', () => {
  it('builds a safe file name', () => {
    expect(pdfFileName('Paris & Rome 2026!')).toBe('paris-rome-2026-itinerary.pdf');
    expect(pdfFileName('東京')).toBe('trip-itinerary.pdf');
  });
  it('caps the file name length', () => {
    const n = pdfFileName('a'.repeat(300));
    expect(n).toBe(`${'a'.repeat(80)}-itinerary.pdf`);
  });
  it('replaces non-Latin characters', () => {
    expect(latinSafe('Café – 東京')).toBe('Café – ??');
  });
});
