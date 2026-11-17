import { describe, expect, test } from 'vitest';
import type { Event } from '@planfully/shared';
import { dayHeading, localStartLabel, roundRangeToHours, timelineRange, validZone } from './model';

function range(e: Event[], tz: string) {
  const r = timelineRange(e, tz);
  if (!r) throw new Error('no range');
  return r;
}

const ev = (start?: string, end?: string, tz = 'UTC'): Event =>
  ({
    id: 'x',
    name: 'n',
    type: 'other',
    start: start ? { local: start, tz } : undefined,
    end: end ? { local: end, tz } : undefined,
    attachments: [],
    participants: [],
    status: 'confirmed',
    source: 'manual',
    createdAt: '2026-01-01T00:00:00Z',
  }) as Event;

describe('timelineRange', () => {
  test('null when nothing is scheduled', () => {
    expect(timelineRange([ev()], 'UTC')).toBeNull();
    expect(timelineRange([], 'UTC')).toBeNull();
  });
  test('whole days around events', () => {
    const r = range([ev('2026-07-14T09:30', '2026-07-15T10:00')], 'UTC');
    expect(new Date(r.fromMs).toISOString()).toBe('2026-07-14T00:00:00.000Z');
    expect(new Date(r.toMs).toISOString()).toBe('2026-07-16T00:00:00.000Z');
  });
  test('end exactly at midnight still gets a following day', () => {
    const r = range([ev('2026-07-14T09:00', '2026-07-15T00:00')], 'UTC');
    expect(new Date(r.toMs).toISOString()).toBe('2026-07-16T00:00:00.000Z');
  });
  test('uses the display zone', () => {
    const r = range([ev('2026-07-14T01:00')], 'America/New_York');
    expect(new Date(r.fromMs).toISOString()).toBe('2026-07-13T04:00:00.000Z');
  });
});

test('roundRangeToHours', () => {
  const r = roundRangeToHours(3_600_000 + 5, 7_200_000 + 1);
  expect(r).toEqual({ fromMs: 3_600_000, toMs: 10_800_000 });
});
test('dayHeading', () => {
  expect(dayHeading(Date.UTC(2026, 6, 14, 12), 'UTC')).toBe('Tue Jul 14');
});
test('localStartLabel shows the event own wall clock', () => {
  expect(localStartLabel(ev('2026-07-14T20:05', undefined, 'Europe/Lisbon'))).toBe('20:05');
  expect(localStartLabel(ev())).toBe('');
});
test('validZone', () => {
  expect(validZone('Europe/Paris', 'UTC')).toBe('Europe/Paris');
  expect(validZone('Nope/Zone', 'UTC')).toBe('UTC');
});
