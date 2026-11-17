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

test('day ticks stay on first moment of day after a skipped midnight (Santiago)', () => {
  const tz = 'America/Santiago'; // 2026-09-06 00:00 does not exist; day starts 01:00
  const from = at('2026-09-03T12:00', tz);
  const to = at('2026-09-10T12:00', tz);
  const t = ticks(makeScale(from, 10), from, to, tz);
  const f = t.map((x) => DateTime.fromMillis(x.ms, { zone: tz }).toFormat("yyyy-MM-dd'T'HH:mm"));
  expect(f).toEqual([
    '2026-09-04T00:00',
    '2026-09-05T00:00',
    '2026-09-06T01:00',
    '2026-09-07T00:00',
    '2026-09-08T00:00',
    '2026-09-09T00:00',
    '2026-09-10T00:00',
  ]);
});

test('week ticks after skipped midnight (Santiago)', () => {
  const tz = 'America/Santiago';
  const from = at('2026-08-24T00:00', tz);
  const to = at('2026-09-30T00:00', tz);
  const t = ticks(makeScale(from, 1), from, to, tz);
  for (const x of t) {
    const dt = DateTime.fromMillis(x.ms, { zone: tz });
    expect(dt.weekday).toBe(1);
    expect(x.ms).toBe(dt.startOf('day').toMillis());
  }
  expect(t.length).toBe(6);
});

test('hour density marks first tick of a skipped-midnight day as the day tick', () => {
  const tz = 'America/Santiago';
  const from = at('2026-09-05T22:00', tz);
  const to = at('2026-09-06T03:00', tz);
  const t = ticks(makeScale(from, 60), from, to, tz);
  const days = t.filter((x) => x.kind === 'day');
  expect(days).toHaveLength(1);
  expect(DateTime.fromMillis(need(days[0]).ms, { zone: tz }).toFormat('yyyy-MM-dd HH:mm')).toBe(
    '2026-09-06 01:00',
  );
});
