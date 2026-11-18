import { describe, expect, test } from 'vitest';
import type { Event } from '@planfully/shared';
import { allZones, cityName, offsetLabel, searchZones, zoneOptions, zoneSummary } from './zones';

type T = { local: string; tz: string };
const ev = (start?: T, end?: T): Event =>
  ({
    id: 'x',
    name: 'n',
    type: 'other',
    start,
    end,
    attachments: [],
    participants: [],
    status: 'confirmed',
    source: 'manual',
  }) as unknown as Event;

const JUL = Date.UTC(2026, 6, 1);

describe('labels', () => {
  test('cityName', () => {
    expect(cityName('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(cityName('UTC')).toBe('UTC');
  });
  test('offsetLabel follows DST at the given date', () => {
    expect(offsetLabel('Europe/Paris', JUL)).toBe('UTC+2');
    expect(offsetLabel('Europe/Paris', Date.UTC(2026, 0, 1))).toBe('UTC+1');
    expect(offsetLabel('Asia/Kolkata', JUL)).toBe('UTC+5:30');
    expect(offsetLabel('America/St_Johns', Date.UTC(2026, 0, 1))).toBe('UTC-3:30');
    expect(offsetLabel('Europe/Lisbon', Date.UTC(2026, 0, 1))).toBe('UTC');
  });
  test('zoneSummary', () => {
    expect(zoneSummary('Europe/Paris', JUL)).toBe('Paris · UTC+2');
  });
});

describe('zoneOptions', () => {
  test('browser first, then event zones most-used first, deduped', () => {
    const events = [
      ev(
        { local: '2026-07-01T10:00', tz: 'Europe/Paris' },
        { local: '2026-07-01T12:00', tz: 'Europe/Lisbon' },
      ),
      ev(
        { local: '2026-07-02T10:00', tz: 'Europe/Lisbon' },
        { local: '2026-07-02T11:00', tz: 'Europe/Lisbon' },
      ),
      ev({ local: '2026-07-03T10:00', tz: 'America/New_York' }),
      ev(),
    ];
    const o = zoneOptions(events, 'America/New_York', JUL);
    expect(o.map((x) => x.value)).toEqual(['', 'Europe/Lisbon', 'Europe/Paris']);
    expect(o[0]).toMatchObject({ isBrowser: true, label: 'Your time (America/New_York)' });
    expect(o[1]).toMatchObject({ label: 'Lisbon (UTC+1)', city: 'Lisbon', offset: 'UTC+1' });
  });
  test('no events: only the browser zone', () => {
    expect(zoneOptions([], 'UTC', JUL)).toHaveLength(1);
  });
  test('ties keep first appearance', () => {
    const o = zoneOptions(
      [
        ev({ local: '2026-07-01T10:00', tz: 'Asia/Tokyo' }),
        ev({ local: '2026-07-01T10:00', tz: 'Europe/Paris' }),
      ],
      'UTC',
      JUL,
    );
    expect(o.map((x) => x.value)).toEqual(['', 'Asia/Tokyo', 'Europe/Paris']);
  });
});

describe('searchZones', () => {
  const zones = [
    'Europe/Paris',
    'America/New_York',
    'America/Argentina/Buenos_Aires',
    'Asia/Tokyo',
  ];
  test('matches city, region and underscores', () => {
    expect(searchZones('paris', zones)).toEqual(['Europe/Paris']);
    expect(searchZones('new york', zones)).toEqual(['America/New_York']);
    expect(searchZones('argentina', zones)).toEqual(['America/Argentina/Buenos_Aires']);
  });
  test('empty query or no match gives nothing', () => {
    expect(searchZones('  ', zones)).toEqual([]);
    expect(searchZones('zzz', zones)).toEqual([]);
  });
  test('allZones includes UTC', () => {
    expect(allZones()).toContain('UTC');
  });
});
