import { describe, expect, it } from 'vitest';
import type { HourlySeries } from '../weather/openMeteo';
import {
  bucketize,
  buildStrip,
  dayLabels,
  describeHit,
  fetchRange,
  hitAt,
  inGap,
  noForecastBands,
  stepFor,
  thinBuckets,
} from './weatherAgg';

const H = 3_600_000;
const T0 = Date.UTC(2026, 6, 14, 0); // 2026-07-14 00:00Z
const mk = (hours: number, start = T0): HourlySeries => ({
  coverage: { fromMs: start, toMs: start + hours * H },
  timeMs: Array.from({ length: hours }, (_, i) => start + i * H),
  tempC: Array.from({ length: hours }, (_, i) => 10 + i),
  windKph: Array.from({ length: hours }, () => 10),
  precipMm: Array.from({ length: hours }, () => 0.5),
});

describe('stepFor', () => {
  it('picks the level by hour height', () => {
    expect(stepFor(48)).toBe('hour');
    expect(stepFor(12)).toBe('hour');
    expect(stepFor(11.9)).toBe('3h');
    expect(stepFor(4)).toBe('3h');
    expect(stepFor(3.9)).toBe('day');
    expect(stepFor(0.5)).toBe('day');
  });
});

describe('bucketize', () => {
  const seg = { fromMs: T0, toMs: T0 + 48 * H };
  it('keeps hours as they are', () => {
    const b = bucketize(mk(48), seg, 'hour', 'UTC');
    expect(b).toHaveLength(48);
    expect(b[3]).toMatchObject({ fromMs: T0 + 3 * H, tempAvg: 13, n: 1 });
  });
  it('groups three hours', () => {
    const b = bucketize(mk(48), seg, '3h', 'UTC');
    expect(b).toHaveLength(16);
    expect(b[1]).toMatchObject({
      fromMs: T0 + 3 * H,
      toMs: T0 + 6 * H,
      tempMin: 13,
      tempMax: 15,
      n: 3,
    });
    expect(b[1]?.precipSum).toBeCloseTo(1.5);
  });
  it('groups by day with min/max and rain total', () => {
    const b = bucketize(mk(48), seg, 'day', 'UTC');
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ tempMin: 10, tempMax: 33, windMax: 10, n: 24 });
    expect(b[0]?.precipSum).toBeCloseTo(12);
    expect(b[1]?.fromMs).toBe(T0 + 24 * H);
  });
  it('days follow the display zone', () => {
    // 00:00Z is 17:00 the previous day in Los Angeles (UTC-7 in July).
    const b = bucketize(mk(48), seg, 'day', 'America/Los_Angeles');
    expect(b[0]?.fromMs).toBe(T0);
    expect(b[0]?.n).toBe(7);
  });
  it('ignores hours outside the segment', () => {
    const b = bucketize(mk(10), { fromMs: T0 + 2 * H, toMs: T0 + 5 * H }, 'hour', 'UTC');
    expect(b.map((x) => x.fromMs)).toEqual([T0 + 2 * H, T0 + 3 * H, T0 + 4 * H]);
  });
});

describe('noForecastBands', () => {
  const seg = { fromMs: 100, toMs: 400 };
  it('is the whole segment without coverage', () => {
    expect(noForecastBands(seg, null, 'empty')).toEqual([{ ...seg, kind: 'none' }]);
  });
  it('is the parts outside coverage', () => {
    expect(noForecastBands(seg, { fromMs: 150, toMs: 300 }, 'ready')).toEqual([
      { fromMs: 100, toMs: 150, kind: 'none' },
      { fromMs: 300, toMs: 400, kind: 'none' },
    ]);
  });
  it('marks failures and ignores loading', () => {
    expect(noForecastBands(seg, null, 'error')[0]?.kind).toBe('error');
    expect(noForecastBands(seg, null, 'loading')).toEqual([]);
  });
});

describe('buildStrip and hitAt', () => {
  const a = { fromMs: T0, toMs: T0 + 6 * H, lat: 1, lng: 1, label: 'Lisbon' };
  const b = { fromMs: T0 + 6 * H, toMs: T0 + 30 * H, lat: 2, lng: 2, label: 'Porto' };
  const strip = buildStrip(
    [
      { segment: a, series: mk(6), status: 'ready' },
      { segment: b, series: { ...mk(0), coverage: null }, status: 'empty' },
    ],
    'hour',
    'UTC',
  );
  it('computes extents', () => {
    expect(strip.extents).toMatchObject({ tempMin: 10, tempMax: 15 });
  });
  it('finds buckets and gaps with the place', () => {
    expect(hitAt(strip.segments, T0 + 2.5 * H)).toMatchObject({ kind: 'bucket', place: 'Lisbon' });
    expect(hitAt(strip.segments, T0 + 10 * H)).toMatchObject({ kind: 'none', place: 'Porto' });
    expect(hitAt(strip.segments, T0 + 40 * H)).toBeNull();
  });
  it('describes hits with units', () => {
    const hit = hitAt(strip.segments, T0 + 2 * H);
    if (!hit) throw new Error('no hit');
    expect(describeHit(hit, 'hour', 'UTC', { temp: 'F', wind: 'mph' })).toBe(
      'Tue Jul 14, 2 AM · Lisbon: 54°F, wind 6 mph, rain 0.02 in',
    );
    const gap = hitAt(strip.segments, T0 + 10 * H);
    if (!gap) throw new Error('no gap');
    expect(describeHit(gap, 'hour', 'UTC', { temp: 'C', wind: 'kmh' })).toBe(
      'Tue Jul 14, 10 AM · Porto: No forecast',
    );
  });
});

describe('mid-day place change', () => {
  const a = { fromMs: T0, toMs: T0 + 14 * H, lat: 1, lng: 1, label: 'Lisbon' };
  const b = { fromMs: T0 + 14 * H, toMs: T0 + 48 * H, lat: 2, lng: 2, label: 'Porto' };
  const input = [
    { segment: a, series: mk(48), status: 'ready' as const },
    { segment: b, series: mk(48), status: 'ready' as const },
  ];
  it('clips daily and 3-hourly buckets to their segment', () => {
    const day = buildStrip(input, 'day', 'UTC').segments;
    expect(day[0]?.buckets[0]).toMatchObject({ fromMs: T0, toMs: T0 + 14 * H, n: 14 });
    expect(day[1]?.buckets[0]).toMatchObject({ fromMs: T0 + 14 * H, toMs: T0 + 24 * H, n: 10 });
    const three = buildStrip(input, '3h', 'UTC').segments;
    expect(three[0]?.buckets.at(-1)).toMatchObject({ fromMs: T0 + 12 * H, toMs: T0 + 14 * H });
    expect(three[1]?.buckets[0]).toMatchObject({ fromMs: T0 + 14 * H, toMs: T0 + 15 * H });
  });
  it('gives one label per day, covering both segments', () => {
    const labels = dayLabels(buildStrip(input, 'day', 'UTC').segments, 'UTC');
    expect(labels.map((l) => l.startMs)).toEqual([T0, T0 + 24 * H]);
    expect(labels[0]).toMatchObject({ tempMin: 10, tempMax: 33 });
  });
});

describe('fetchRange', () => {
  it('adds a margin and rounds to whole days', () => {
    const r = fetchRange({ fromMs: T0 + 10 * H, toMs: T0 + 20 * H });
    expect(r).toEqual({ fromMs: T0, toMs: T0 + 48 * H });
  });
});

describe('thinBuckets (condensed time)', () => {
  const seg = { fromMs: T0, toMs: T0 + 40 * H, lat: 1, lng: 1, label: 'X' };
  const hourly = bucketize(mk(40), seg, 'hour', 'UTC');
  const input = [{ segment: seg, series: mk(40), status: 'ready' as const }];
  // Hours 4..36 collapsed into 24px; the rest is 20 px/h.
  const gap = { fromMs: T0 + 4 * H, toMs: T0 + 36 * H, fromY: 80, toY: 104 };
  const toY = (ms: number) => {
    const h = (ms - T0) / H;
    if (h <= 4) return h * 20;
    if (h >= 36) return 104 + (h - 36) * 20;
    return 80 + ((h - 4) / 32) * 24;
  };
  const lin = (ms: number) => ((ms - T0) / H) * 20;

  it('returns buckets unchanged without gaps (linear mode)', () => {
    expect(thinBuckets(hourly, [], lin)).toEqual(hourly);
    expect(buildStrip(input, 'hour', 'UTC').segments[0]?.buckets).toEqual(hourly);
    expect(buildStrip(input, 'hour', 'UTC', [], lin).segments[0]?.buckets).toEqual(hourly);
  });
  it('folds the squashed hours of a gap into one bucket and keeps the others', () => {
    const out = thinBuckets(hourly, [gap], toY);
    expect(out).toHaveLength(4 + 1 + 4);
    const m = out[4];
    expect(m).toMatchObject({ fromMs: gap.fromMs, toMs: gap.toMs, n: 32, merged: true });
    expect(m?.tempMin).toBe(14);
    expect(m?.tempMax).toBe(45);
    expect(m?.tempAvg).toBeCloseTo(29.5);
    expect(m?.precipSum).toBeCloseTo(16);
    expect(out[3]?.merged).toBeUndefined();
    expect(out[8]?.toMs).toBe(T0 + 40 * H);
  });
  it('does not fold buckets drawn tall enough (short gap at its linear height)', () => {
    const small = { fromMs: T0 + 4 * H, toMs: T0 + 6 * H, fromY: 80, toY: 120 };
    expect(thinBuckets(hourly, [small], lin)).toEqual(hourly);
  });
  it('keeps the hit-test working across the folded bucket', () => {
    const strip = buildStrip(input, 'hour', 'UTC', [gap], toY);
    const hit = hitAt(strip.segments, T0 + 20.5 * H);
    expect(hit).toMatchObject({ kind: 'bucket' });
    if (hit?.kind === 'bucket') {
      expect(hit.bucket.merged).toBe(true);
      expect(describeHit(hit, 'hour', 'UTC', { temp: 'C', wind: 'kmh' })).toContain(' to ');
    }
    expect(hitAt(strip.segments, T0 + 2.5 * H)).toMatchObject({ kind: 'bucket' });
  });
  it('inGap is strict', () => {
    expect(inGap(gap.fromMs, [gap])).toBe(false);
    expect(inGap(gap.fromMs + 1, [gap])).toBe(true);
    expect(inGap(gap.toMs, [gap])).toBe(false);
  });
});
