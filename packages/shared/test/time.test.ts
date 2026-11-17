import { describe, expect, test } from 'vitest';
import { dayKey, eventInterval, fromInstant, toInstant } from '../src';
import { flightEvent, landmarkEvent } from './fixtures';

function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error('expected a value');
  return v;
}

const HOUR = 3600_000;

describe('time', () => {
  test('toInstant / fromInstant round trip', () => {
    const t = { local: '2026-06-01T16:30', tz: 'America/Los_Angeles' };
    expect(toInstant(t)).toBe(Date.UTC(2026, 5, 1, 23, 30));
    expect(fromInstant(toInstant(t), t.tz)).toEqual(t);
    expect(fromInstant(Date.UTC(2026, 5, 1, 23, 30), 'Asia/Tokyo')).toEqual({
      local: '2026-06-02T08:30',
      tz: 'Asia/Tokyo',
    });
  });

  test('DST spring forward: gap time shifts forward; elapsed time is 1h across the gap', () => {
    const tz = 'America/New_York';
    const before = toInstant({ local: '2026-03-08T01:30', tz });
    const after = toInstant({ local: '2026-03-08T03:30', tz });
    expect(after - before).toBe(HOUR);
    // 02:30 does not exist: luxon resolves it to 03:30 EDT
    const gap = { local: '2026-03-08T02:30', tz };
    expect(toInstant(gap)).toBe(after);
    expect(fromInstant(toInstant(gap), tz).local).toBe('2026-03-08T03:30');
  });

  test('DST fall back: repeated hour resolves to the later (standard-time) occurrence, as luxon does; day is 25h', () => {
    const tz = 'America/New_York';
    const amb = toInstant({ local: '2026-11-01T01:30', tz });
    expect(amb).toBe(Date.UTC(2026, 10, 1, 6, 30)); // 01:30 EST, the second occurrence
    const start = toInstant({ local: '2026-11-01T00:00', tz });
    const next = toInstant({ local: '2026-11-02T00:00', tz });
    expect(next - start).toBe(25 * HOUR);
    expect(fromInstant(Date.UTC(2026, 10, 1, 6, 30), tz).local).toBe('2026-11-01T01:30');
  });

  test('flight departing and arriving in different zones', () => {
    const iv = must(eventInterval(flightEvent));
    expect(iv.start).toBe(Date.UTC(2026, 5, 1, 23, 30));
    expect(iv.end).toBe(Date.UTC(2026, 5, 2, 10, 5));
    expect((iv.end - iv.start) / HOUR).toBeCloseTo(10.583, 2);
    expect(dayKey(must(flightEvent.start))).toBe('2026-06-01');
    expect(dayKey(must(flightEvent.end))).toBe('2026-06-02');
  });

  test('eventInterval: unscheduled is null, end defaults to start', () => {
    expect(eventInterval(landmarkEvent)).toBeNull();
    const { end: _e, ...noEnd } = flightEvent;
    const iv = must(eventInterval(noEnd));
    expect(iv.end).toBe(iv.start);
  });

  test('dayKey uses the event zone, not UTC', () => {
    expect(dayKey({ local: '2026-06-01T23:30', tz: 'America/Los_Angeles' })).toBe('2026-06-01');
  });
});
