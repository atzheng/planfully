import { DateTime } from 'luxon';
import { expect, test } from 'vitest';
import { makeScale, tickDensity, ticks } from './scale';

function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing');
  return v;
}
const H = 3_600_000;

test('toY and toMs round-trip', () => {
  const s = makeScale(1_000_000, 48);
  expect(s.toY(1_000_000)).toBe(0);
  expect(s.toY(1_000_000 + 2 * H)).toBe(96);
  for (const ms of [0, 1_000_000, 123_456_789]) expect(s.toMs(s.toY(ms))).toBeCloseTo(ms, 3);
  expect(s.toY(s.toMs(-250))).toBeCloseTo(-250, 6);
});

test('density thresholds', () => {
  expect(tickDensity(240)).toBe('hour');
  expect(tickDensity(30)).toBe('hour');
  expect(tickDensity(29.9)).toBe('day');
  expect(tickDensity(4)).toBe('day');
  expect(tickDensity(3.9)).toBe('week');
  expect(tickDensity(1)).toBe('week');
});

const at = (iso: string, tz: string) => DateTime.fromISO(iso, { zone: tz }).toMillis();

test('hour ticks, midnight is a day tick', () => {
  const tz = 'Europe/Paris';
  const from = at('2026-06-01T22:00', tz);
  const to = at('2026-06-02T02:00', tz);
  const t = ticks(makeScale(from, 60), from, to, tz);
  expect(t.map((x) => x.kind)).toEqual(['hour', 'hour', 'day', 'hour', 'hour']);
  expect(need(t[0]).label).toBe('10 PM');
  expect(need(t[2]).label).toBe('Tue Jun 2');
});

test('day ticks fall on local midnight across DST (spring forward)', () => {
  const tz = 'America/Los_Angeles';
  const from = at('2026-03-07T12:00', tz);
  const to = at('2026-03-11T12:00', tz);
  const t = ticks(makeScale(from, 10), from, to, tz);
  expect(t.length).toBe(4);
  for (const x of t) {
    expect(x.kind).toBe('day');
    const dt = DateTime.fromMillis(x.ms, { zone: tz });
    expect([dt.hour, dt.minute]).toEqual([0, 0]);
  }
  expect(need(t[1]).ms - need(t[0]).ms).toBe(23 * H); // Mar 8 -> Mar 9 loses an hour
});

test('day ticks across fall back', () => {
  const tz = 'Europe/Paris';
  const from = at('2026-10-24T12:00', tz);
  const to = at('2026-10-28T12:00', tz);
  const t = ticks(makeScale(from, 10), from, to, tz);
  expect(t.map((x) => DateTime.fromMillis(x.ms, { zone: tz }).toISODate())).toEqual([
    '2026-10-25',
    '2026-10-26',
    '2026-10-27',
    '2026-10-28',
  ]);
  expect(need(t[1]).ms - need(t[0]).ms).toBe(25 * H);
});

test('week ticks on local Monday midnight', () => {
  const tz = 'Asia/Tokyo';
  const from = at('2026-06-01T00:00', tz); // a Monday
  const to = at('2026-06-30T00:00', tz);
  const t = ticks(makeScale(from, 1), from, to, tz);
  expect(t.every((x) => x.kind === 'week')).toBe(true);
  expect(t.length).toBe(5);
  for (const x of t) {
    const dt = DateTime.fromMillis(x.ms, { zone: tz });
    expect([dt.weekday, dt.hour]).toEqual([1, 0]);
  }
});

test('empty range', () => {
  expect(ticks(makeScale(0, 10), 5, 1, 'UTC')).toEqual([]);
});
