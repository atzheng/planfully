import { expect, test } from 'vitest';
import { dayNight, sunDays } from './sun';

const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);
const MIN = 60_000;

test('sunrise and sunset in London on the 2024 June solstice (published 03:43 / 20:21 UTC)', () => {
  const [d] = sunDays(51.5074, -0.1278, at('2024-06-21T00:00Z'), at('2024-06-21T23:59Z')).filter(
    (x) =>
      x.kind === 'normal' &&
      x.transitMs > at('2024-06-21T00:00Z') &&
      x.transitMs < at('2024-06-22T00:00Z'),
  );
  if (d?.kind !== 'normal') throw new Error('expected a normal day');
  expect(Math.abs(d.riseMs - at('2024-06-21T03:43Z'))).toBeLessThan(3 * MIN);
  expect(Math.abs(d.setMs - at('2024-06-21T20:21Z'))).toBeLessThan(3 * MIN);
});

test('Tokyo, 1 Jan 2025 (published 06:51 / 16:38 JST)', () => {
  const { marks } = dayNight([
    {
      fromMs: at('2024-12-31T15:00Z'),
      toMs: at('2025-01-01T15:00Z'),
      lat: 35.68,
      lng: 139.69,
      label: '',
    },
  ]);
  expect(marks.map((m) => m.kind)).toEqual(['rise', 'set']);
  expect(Math.abs((marks[0]?.ms ?? 0) - at('2025-01-01T06:51+09:00'))).toBeLessThan(3 * MIN);
  expect(Math.abs((marks[1]?.ms ?? 0) - at('2025-01-01T16:38+09:00'))).toBeLessThan(3 * MIN);
});

test('nights fill the segment outside daylight and are clipped to it', () => {
  const seg = {
    fromMs: at('2025-03-10T00:00Z'),
    toMs: at('2025-03-12T00:00Z'),
    lat: 0,
    lng: 0,
    label: '',
  };
  const { nights, marks } = dayNight([seg]);
  expect(nights[0]?.fromMs).toBe(seg.fromMs);
  expect(nights[nights.length - 1]?.toMs).toBe(seg.toMs);
  expect(nights).toHaveLength(3);
  expect(marks).toHaveLength(4);
  // Equator around the equinox: about 12 hours of night between sunset and the next sunrise.
  const mid = nights[1] ?? { fromMs: 0, toMs: 0 };
  expect(Math.abs(mid.toMs - mid.fromMs - 11.9 * H)).toBeLessThan(0.3 * H);
});

test('polar day has no night, polar night is all night, no marks', () => {
  const summer = {
    fromMs: at('2025-06-20T00:00Z'),
    toMs: at('2025-06-22T00:00Z'),
    lat: 78.2,
    lng: 15.6,
    label: '',
  };
  expect(dayNight([summer])).toEqual({ nights: [], marks: [] });
  const winter = { ...summer, fromMs: at('2025-12-20T00:00Z'), toMs: at('2025-12-22T00:00Z') };
  expect(dayNight([winter])).toEqual({
    nights: [{ fromMs: winter.fromMs, toMs: winter.toMs }],
    marks: [],
  });
});

test('adjacent segments use their own place and merge touching nights', () => {
  const t0 = at('2025-03-10T00:00Z');
  const { nights } = dayNight([
    { fromMs: t0, toMs: t0 + 2 * H, lat: 0, lng: 0, label: 'a' },
    { fromMs: t0 + 2 * H, toMs: t0 + 4 * H, lat: 0, lng: 10, label: 'b' },
  ]);
  expect(nights).toEqual([{ fromMs: t0, toMs: t0 + 4 * H }]);
  expect(dayNight([])).toEqual({ nights: [], marks: [] });
});
