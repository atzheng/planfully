import { expect, test } from 'vitest';
import { BACKGROUND_EVENT_MS, condensedPx, findGaps, formatGap, GAP_MARGIN_MS } from './condense';
import { fitPx } from './zoom';
import { GAP_PX, makeScale, MIN_PX_PER_HOUR, ticks } from './scale';
import type { Gap } from './scale';

const H = 3_600_000;
const iv = (startH: number, endH: number) => ({ start: startH * H, end: endH * H });

test('gaps over the threshold collapse, with a margin kept on each side', () => {
  const gaps = findGaps([iv(0, 2), iv(3, 4), iv(20, 22)]);
  expect(gaps).toEqual([{ fromMs: 5 * H, toMs: 19 * H }]);
  expect(GAP_MARGIN_MS).toBe(H);
});

test('a gap exactly at the threshold, or shorter, stays', () => {
  expect(findGaps([iv(0, 1), iv(7, 8)])).toEqual([]);
  expect(findGaps([iv(0, 1), iv(7.5, 8)])).toHaveLength(1);
});

test('overlapping events and long events are handled', () => {
  // The first event reaches past the second one's start.
  expect(findGaps([iv(0, 30 / 24 + 10), iv(2, 3), iv(30, 31)])).toEqual([
    { fromMs: (30 / 24 + 11) * H, toMs: 29 * H },
  ]);
  // A multi-day stay does not keep the nights from collapsing.
  const stay = { start: 0, end: BACKGROUND_EVENT_MS * 3 };
  expect(findGaps([stay, iv(10, 11), iv(40, 41)])).toHaveLength(1);
});

test('no gaps before the first or after the last event; nothing scheduled gives none', () => {
  expect(findGaps([iv(50, 51)])).toEqual([]);
  expect(findGaps([])).toEqual([]);
});

test('formatGap', () => {
  expect(formatGap(14 * H)).toBe('14 h');
  expect(formatGap(47.6 * H)).toBe('2 d');
  expect(formatGap(78 * H)).toBe('3 d 6 h');
});

test('a gap is drawn GAP_PX tall and shifts everything after it up', () => {
  const s = makeScale(0, 10, [{ fromMs: 2 * H, toMs: 20 * H }]);
  expect(s.toY(2 * H)).toBe(20);
  expect(s.toY(20 * H)).toBe(20 + GAP_PX);
  expect(s.toY(21 * H)).toBe(30 + GAP_PX);
  expect(s.toY(11 * H)).toBeCloseTo(20 + GAP_PX / 2);
  expect(s.gaps).toEqual([{ fromMs: 2 * H, toMs: 20 * H, fromY: 20, toY: 20 + GAP_PX }]);
  expect(s.pxPerHourAt(H)).toBe(10);
  expect(s.pxPerHourAt(5 * H)).toBeCloseTo(GAP_PX / 18);
  expect(s.pxPerHourAt(25 * H)).toBe(10);
  // Zoom only stretches the busy part.
  const z = makeScale(0, 20, [{ fromMs: 2 * H, toMs: 20 * H }]);
  expect(z.toY(21 * H)).toBe(2 * 20 + GAP_PX + 20);
});

test('no gaps is the old linear scale', () => {
  const s = makeScale(1_000_000, 48);
  expect(s.gaps).toEqual([]);
  expect(s.toY(1_000_000 + 2 * H)).toBe(96);
  expect(s.pxPerHourAt(0)).toBe(48);
});

test('gaps before the origin are clipped or dropped; overlapping gaps are dropped', () => {
  const s = makeScale(10 * H, 10, [
    { fromMs: 0, toMs: 5 * H },
    { fromMs: 8 * H, toMs: 14 * H },
    { fromMs: 12 * H, toMs: 30 * H },
  ]);
  expect(s.gaps).toHaveLength(2);
  expect(s.gaps[0]).toMatchObject({ fromMs: 10 * H, toMs: 14 * H, fromY: 0 });
  expect(s.gaps[1]).toMatchObject({ fromMs: 14 * H, toMs: 30 * H });
});

// Small seeded PRNG so the property tests are reproducible.
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: toY and toMs are inverse and strictly increasing for random scales', () => {
  const rand = rng(42);
  for (let run = 0; run < 200; run++) {
    const origin = Math.floor(rand() * 1e12);
    const px = 0.5 * 240 ** rand(); // log-uniform 0.5..120, so low zoom is well covered
    const n = Math.floor(rand() * 6);
    const gaps: Gap[] = [];
    for (let i = 0; i < n; i++) {
      const from = origin + (rand() * 200 - 20) * H;
      gaps.push({ fromMs: from, toMs: from + (0.5 + rand() * 80) * H });
    }
    const s = makeScale(origin, px, gaps);
    let prevMs = origin - 50 * H;
    let prevY = s.toY(prevMs);
    for (let k = 1; k <= 400; k++) {
      const ms = origin - 50 * H + k * 0.7 * H + rand() * 1000;
      if (ms <= prevMs) continue;
      const y = s.toY(ms);
      expect(y).toBeGreaterThan(prevY);
      expect(s.toMs(y)).toBeCloseTo(ms, 0);
      expect(s.toY(s.toMs(y))).toBeCloseTo(y, 4);
      expect(s.toMs(y)).toBeGreaterThan(s.toMs(prevY));
      prevMs = ms;
      prevY = y;
    }
    // Continuous at the gap edges.
    for (const g of s.gaps) {
      expect(s.toY(g.fromMs)).toBeCloseTo(g.fromY, 6);
      expect(s.toY(g.toMs)).toBeCloseTo(g.toY, 6);
      const linear = ((g.toMs - g.fromMs) / H) * px;
      expect(g.toY - g.fromY).toBeCloseTo(Math.min(GAP_PX, linear), 6);
      expect(g.toY - g.fromY).toBeLessThanOrEqual(linear + 1e-9);
    }
  }
});

test('property: findGaps output is sorted, disjoint and never covers a busy event', () => {
  const rand = rng(7);
  for (let run = 0; run < 200; run++) {
    const ivs = Array.from({ length: 1 + Math.floor(rand() * 12) }, () => {
      const start = rand() * 400 * H;
      return { start, end: start + rand() * 5 * H };
    });
    const gaps = findGaps(ivs);
    for (let i = 0; i < gaps.length; i++) {
      const g = gaps[i];
      if (!g) continue;
      expect(g.toMs).toBeGreaterThan(g.fromMs);
      const next = gaps[i + 1];
      if (next) expect(next.fromMs).toBeGreaterThanOrEqual(g.toMs);
      for (const e of ivs) expect(e.end <= g.fromMs || e.start >= g.toMs).toBe(true);
    }
  }
});

test('ticks skip the inside of a gap but keep its edges', () => {
  const s = makeScale(0, 48, [{ fromMs: 2 * H, toMs: 20 * H }]);
  const list = ticks(s, 0, 24 * H, 'UTC').map((t) => t.ms / H);
  expect(list).toEqual([0, 1, 2, 20, 21, 22, 23, 24]);
});

test('an overnight gap still yields a day tick for the next day; a multi-day gap yields the last day', () => {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  // Gap 21:00 Mon to 08:00 Tue (midnight inside).
  const night = { fromMs: day('2026-03-02') + 21 * H, toMs: day('2026-03-03') + 8 * H };
  const s = makeScale(day('2026-03-02'), 48, [night]);
  const list = ticks(s, day('2026-03-02'), day('2026-03-04'), 'UTC');
  const at = list.find((t) => t.ms === night.toMs);
  expect(at).toMatchObject({ kind: 'day', label: 'Tue Mar 3' });
  expect(list.filter((t) => t.ms > night.fromMs && t.ms < night.toMs)).toEqual([]);
  expect(list.map((t) => t.ms)).toEqual([...list.map((t) => t.ms)].sort((a, b) => a - b));
  expect(new Set(list.map((t) => t.ms)).size).toBe(list.length);
  // Gap 21:00 Mon to 08:00 Thu: the last day wins.
  const long = { fromMs: night.fromMs, toMs: day('2026-03-05') + 8 * H };
  const s2 = makeScale(day('2026-03-02'), 48, [long]);
  const l2 = ticks(s2, day('2026-03-02'), day('2026-03-06'), 'UTC');
  expect(l2.find((t) => t.ms === long.toMs)).toMatchObject({ kind: 'day', label: 'Thu Mar 5' });
  // Day density too (zoomed out).
  const s3 = makeScale(day('2026-03-02'), 10, [night]);
  const l3 = ticks(s3, day('2026-03-02'), day('2026-03-04'), 'UTC');
  expect(l3.find((t) => t.ms === night.toMs)).toMatchObject({ kind: 'day', label: 'Tue Mar 3' });
});

test('a short gap at low zoom is not taller than the time it replaces', () => {
  const s = makeScale(0, 2, [{ fromMs: 10 * H, toMs: 15 * H }]); // 5 h at 2 px/h = 10 px < 24
  expect(s.gaps[0]?.toY).toBeCloseTo(20 + 10, 6);
  expect(s.toY(15 * H)).toBeCloseTo(30, 6);
  expect(s.toY(20 * H)).toBeCloseTo(40, 6); // same as the linear scale
  expect(s.toMs(s.toY(12 * H))).toBeCloseTo(12 * H, 0);
});

test('condensedPx and fitPx use the same gap height rule', () => {
  const gaps = [{ fromMs: 10 * H, toMs: 34 * H }];
  expect(condensedPx(gaps, 0, 48 * H, 20)).toBeCloseTo(24 * 20 + GAP_PX);
  // Half of the gap is in range: half of its height.
  expect(condensedPx(gaps, 0, 22 * H, 20)).toBeCloseTo(10 * 20 + GAP_PX / 2);
  expect(condensedPx(gaps, 40 * H, 50 * H, 20)).toBeCloseTo(200);
  // Low zoom: the 24 h gap at 0.5 px/h is 12 px, not 24.
  expect(condensedPx(gaps, 0, 48 * H, 0.5)).toBeCloseTo(24);
  expect(fitPx(0, 48 * H, 504, gaps)).toBeCloseTo(20, 4);
  // Without gaps it is the plain fit.
  expect(fitPx(0, 48 * H, 480)).toBe(10);
  // The fitted scale really fits, at several zoom levels (including low, where gaps are short).
  const many = [
    { fromMs: 10 * H, toMs: 15 * H },
    { fromMs: 30 * H, toMs: 50 * H },
    { fromMs: 100 * H, toMs: 104 * H },
  ];
  for (const vp of [60, 120, 300, 504, 2000]) {
    for (const g of [gaps, many]) {
      const px = fitPx(0, 150 * H, vp, g);
      if (px <= MIN_PX_PER_HOUR || px >= 120) continue;
      expect(makeScale(0, px, g).toY(150 * H)).toBeCloseTo(vp, 3);
    }
  }
  // A viewport smaller than the gaps alone falls back to the minimum zoom.
  expect(fitPx(0, 48 * H, 10, gaps)).toBe(MIN_PX_PER_HOUR);
});
