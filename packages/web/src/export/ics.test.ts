import { describe, expect, it } from 'vitest';
import type { Event } from '@planfully/shared';
import { buildIcs, escapeText, foldLine, icsFileName } from './ics';

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
const NOW = new Date('2026-01-02T03:04:05Z');
const roster = [{ id: 'a', name: 'Ann', aliases: [] }];
const unfold = (s: string) => s.replace(/\r\n /g, '');
const utcStart = { local: '2026-07-14T09:30', tz: 'UTC' };

describe('escapeText', () => {
  it('escapes backslash, semicolon, comma and newlines', () => {
    expect(escapeText('a\\b;c,d\ne\r\nf')).toBe('a\\\\b\\;c\\,d\\ne\\nf');
  });
});

describe('foldLine', () => {
  it('folds at 75 octets without splitting multi-byte characters', () => {
    const line = 'DESCRIPTION:' + 'é€😀'.repeat(40);
    const parts = foldLine(line);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
    expect(unfold(parts.join('\r\n'))).toBe(line);
  });
  it('leaves short lines alone', () => {
    expect(foldLine('SUMMARY:hi')).toEqual(['SUMMARY:hi']);
  });
});

describe('buildIcs', () => {
  it('uses CRLF and wraps in VCALENDAR', () => {
    const s = buildIcs([], 'T', [], NOW);
    expect(s.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(s.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(s.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('converts a flight crossing zones to UTC', () => {
    const s = buildIcs(
      [
        ev({
          id: 'f1',
          type: 'flight',
          start: { local: '2026-07-14T09:30', tz: 'Europe/Paris' },
          end: { local: '2026-07-14T11:45', tz: 'America/New_York' },
        }),
      ],
      'T',
      [],
      NOW,
    );
    expect(s).toContain('DTSTART:20260714T073000Z');
    expect(s).toContain('DTEND:20260714T154500Z');
    expect(s).toContain('DTSTAMP:20260102T030405Z');
    expect(s).toContain('UID:f1@planfully');
  });

  it('UID is stable across runs', () => {
    const e = ev({ id: 'x', start: utcStart });
    const uid = (s: string) => /UID:(.*)\r/.exec(s)?.[1];
    expect(uid(buildIcs([e], 'T', [], NOW))).toBe(uid(buildIcs([e], 'T', [], new Date())));
  });

  it('marks cancelled events', () => {
    const s = buildIcs([ev({ id: 'c', status: 'cancelled', start: utcStart })], 'T', [], NOW);
    expect(s).toContain('STATUS:CANCELLED');
    expect(buildIcs([ev({ id: 'd', start: utcStart })], 'T')).not.toContain('STATUS');
  });

  it('defaults to one hour when there is no end, skips unscheduled', () => {
    const s = buildIcs(
      [
        ev({ id: 'a1', type: 'dining', start: { local: '2026-07-14T19:00', tz: 'Europe/Paris' } }),
        ev({ id: 'none' }),
      ],
      'T',
      [],
      NOW,
    );
    expect(s).toContain('DTSTART:20260714T170000Z');
    expect(s).toContain('DTEND:20260714T180000Z');
    expect(s).not.toContain('none@planfully');
    expect(s.match(/BEGIN:VEVENT/g)).toHaveLength(1);
  });

  it('writes location, geo and description', () => {
    const s = unfold(
      buildIcs(
        [
          ev({
            id: 'h',
            name: 'Hotel, Paris',
            start: { local: '2026-07-14T15:00', tz: 'Europe/Paris' },
            location: { name: 'Hôtel X', address: '1 Rue A; Paris', lat: 48.5, lng: 2.25 },
            confirmation: 'ABC123',
            participants: ['a', 'gone'],
            notes: 'Late\ncheck-in',
          }),
        ],
        'T',
        roster,
        NOW,
      ),
    );
    expect(s).toContain('SUMMARY:Hotel\\, Paris');
    expect(s).toContain('LOCATION:Hôtel X\\, 1 Rue A\\; Paris');
    expect(s).toContain('GEO:48.500000;2.250000');
    expect(s).toContain(
      'DESCRIPTION:Confirmation: ABC123\\nParticipants: Ann\\, Former participant\\nLate\\ncheck-in',
    );
  });
});

describe('GEO', () => {
  it('never uses exponent notation', () => {
    const s = buildIcs(
      [ev({ id: 'g', start: utcStart, location: { lat: 1e-7, lng: -0.0000005 } })],
      'T',
      [],
      NOW,
    );
    expect(s).toContain('GEO:0.000000;-0.000001');
    expect(s).not.toMatch(/GEO:.*e/i);
  });
});

describe('icsFileName', () => {
  it('slugs and caps the trip name', () => {
    expect(icsFileName('Paris 2026!')).toBe('paris-2026.ics');
    expect(icsFileName('x'.repeat(200)).length).toBe(84);
    expect(icsFileName('')).toBe('trip.ics');
  });
});
