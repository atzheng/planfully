import { describe, expect, test } from 'vitest';
import type { Event } from '@planfully/shared';
import { canonicalZone, cityName, sameZone, searchZones, zoneOptions } from './zones';

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

describe('aliases and invalid zones', () => {
  test('canonical/same zone', () => {
    expect(sameZone('US/Eastern', 'America/New_York')).toBe(true);
    expect(sameZone('Etc/UTC', 'UTC')).toBe(true);
    expect(sameZone('Asia/Calcutta', 'Asia/Kolkata')).toBe(true);
    expect(sameZone('Europe/Paris', 'Europe/Lisbon')).toBe(false);
    expect(canonicalZone('Not/AZone')).toBeNull();
    expect(sameZone('Not/AZone', 'Not/AZone')).toBe(false);
  });
  test('search finds legacy-named zones by modern names', () => {
    const zones = [
      'Asia/Calcutta',
      'Europe/Kiev',
      'Asia/Katmandu',
      'Asia/Saigon',
      'America/Godthab',
      'Asia/Rangoon',
    ];
    expect(searchZones('kolkata', zones)).toEqual(['Asia/Calcutta']);
    expect(searchZones('kyiv', zones)).toEqual(['Europe/Kiev']);
    expect(searchZones('kathmandu', zones)).toEqual(['Asia/Katmandu']);
    expect(searchZones('ho chi minh', zones)).toEqual(['Asia/Saigon']);
    expect(searchZones('nuuk', zones)).toEqual(['America/Godthab']);
    expect(searchZones('yangon', zones)).toEqual(['Asia/Rangoon']);
    expect(searchZones('calcutta', zones)).toEqual(['Asia/Calcutta']);
    expect(cityName('Asia/Calcutta')).toBe('Kolkata');
  });
  test('zoneOptions dedupes aliases of browser and each other, drops invalid', () => {
    const events = [
      ev({ local: '2026-07-01T10:00', tz: 'US/Eastern' }),
      ev({ local: '2026-07-01T10:00', tz: 'Etc/UTC' }, { local: '2026-07-01T11:00', tz: 'UTC' }),
      ev({ local: '2026-07-01T10:00', tz: 'Bogus/Zone' }),
    ];
    const o = zoneOptions(events, 'America/New_York', JUL);
    expect(o.map((x) => x.value)).toEqual(['', 'UTC']);
  });
});
