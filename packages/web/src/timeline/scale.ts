import { createContext, useContext } from 'react';
import { DateTime } from 'luxon';

const HOUR_MS = 3_600_000;

/** A collapsed stretch with no events: `fromMs..toMs` is drawn `GAP_PX` tall (condensed time, 6s9). */
export type Gap = { fromMs: number; toMs: number };
export type ScaleGap = Gap & { fromY: number; toY: number };

/** Height of a collapsed gap. */
export const GAP_PX = 24;

export type TimeScale = {
  /** Nominal density: px per hour in the busy (non-collapsed) segments. */
  pxPerHour: number;
  originMs: number;
  /** Collapsed stretches in ascending order, with their y extents. Empty for a linear scale. */
  gaps: readonly ScaleGap[];
  toY(ms: number): number;
  toMs(y: number): number;
  /** Local density at `ms`: `pxPerHour` in busy segments, GAP_PX over the gap's length inside a gap. */
  pxPerHourAt(ms: number): number;
};

/**
 * Time to y. With no `gaps` this is linear (`pxPerHour`). Each gap is drawn `GAP_PX` tall instead of
 * its length, so the scale is piecewise linear, strictly increasing, and `toMs` is the exact inverse
 * of `toY`. Gaps are sorted, clipped to start at or after `originMs`, and overlapping or empty ones
 * are dropped. Zoom (`pxPerHour`) only stretches the busy segments; gaps stay `GAP_PX`.
 */
export function makeScale(
  originMs: number,
  pxPerHour: number,
  gaps: readonly Gap[] = [],
): TimeScale {
  if (!(pxPerHour > 0)) throw new Error('pxPerHour must be positive');
  const busy = pxPerHour / HOUR_MS; // px per ms in busy segments
  // Knots alternate: even index starts a busy segment, odd index starts a gap.
  const ms: number[] = [originMs];
  const ys: number[] = [0];
  const slopes: number[] = [busy];
  const out: ScaleGap[] = [];
  const sorted = [...gaps].sort((a, b) => a.fromMs - b.fromMs);
  for (const g of sorted) {
    const i = ms.length - 1;
    const from = Math.max(g.fromMs, ms[i] ?? originMs);
    if (!(g.toMs > from)) continue;
    const fromY = (ys[i] ?? 0) + (from - (ms[i] ?? 0)) * busy;
    const toY = fromY + GAP_PX;
    ms.push(from, g.toMs);
    ys.push(fromY, toY);
    slopes.push(GAP_PX / (g.toMs - from), busy);
    out.push({ fromMs: from, toMs: g.toMs, fromY, toY });
  }
  const last = ms.length - 1;
  // Index of the last knot <= v in `arr` (ascending), or -1 when v is before the first knot.
  const find = (arr: number[], v: number): number => {
    let lo = 0;
    let hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((arr[mid] ?? Infinity) <= v) lo = mid;
      else hi = mid - 1;
    }
    return (arr[lo] ?? Infinity) <= v ? lo : -1;
  };
  return {
    pxPerHour,
    originMs,
    gaps: out,
    toY(t) {
      const i = find(ms, t);
      if (i < 0) return (t - originMs) * busy;
      return (ys[i] ?? 0) + (t - (ms[i] ?? 0)) * (slopes[i] ?? busy);
    },
    toMs(y) {
      const i = find(ys, y);
      if (i < 0) return originMs + y / busy;
      return (ms[i] ?? 0) + (y - (ys[i] ?? 0)) / (slopes[i] ?? busy);
    },
    pxPerHourAt(t) {
      const i = find(ms, t);
      return i < 0 ? pxPerHour : (slopes[i] ?? busy) * HOUR_MS;
    },
  };
}

/** Suggested zoom limits for the view (gy4.7). */
export const MIN_PX_PER_HOUR = 0.5;
export const MAX_PX_PER_HOUR = 120;

/** pxPerHour at or above this shows hour ticks (midnights still shown as day ticks). */
export const HOUR_TICK_MIN_PX_PER_HOUR = 30;
/** pxPerHour at or above this (and below the hour threshold) shows day ticks; below it, week ticks. */
export const DAY_TICK_MIN_PX_PER_HOUR = 4;

export type TickKind = 'hour' | 'day' | 'week';
export type Tick = { ms: number; label: string; kind: TickKind };

/** Which tick unit is shown at this zoom. Hour: >= 30 px/h. Day: >= 4 px/h. Week: below 4 px/h. */
export function tickDensity(pxPerHour: number): TickKind {
  if (pxPerHour >= HOUR_TICK_MIN_PX_PER_HOUR) return 'hour';
  if (pxPerHour >= DAY_TICK_MIN_PX_PER_HOUR) return 'day';
  return 'week';
}

const dayLabel = (dt: DateTime) => dt.toFormat('ccc LLL d');

/**
 * Axis ticks within [fromMs, toMs] (inclusive), in `tz`. Day and week ticks fall on local midnight
 * (weeks start Monday). In hour density, midnights are emitted as kind 'day' and other hours as 'hour'.
 * Stepping is calendar-based so DST changes keep ticks on local boundaries (a 23h or 25h day is one step).
 */
export function ticks(scale: TimeScale, fromMs: number, toMs: number, tz: string): Tick[] {
  if (toMs < fromMs) return [];
  const density = tickDensity(scale.pxPerHour);
  const start = DateTime.fromMillis(fromMs, { zone: tz });
  if (!start.isValid) throw new Error(`invalid zone: ${tz}`);
  const unit = density === 'hour' ? 'hour' : density === 'day' ? 'day' : 'week';
  const out: Tick[] = [];
  const base = start.startOf(unit);
  // Each tick is derived from the base (not chained from the previous tick) so a skipped local
  // midnight cannot shift later ticks off midnight; startOf('day') re-resolves to the day's first moment.
  for (let i = 0; ; i++) {
    let cur = base.plus({ [unit + 's']: i });
    if (unit !== 'hour') cur = cur.startOf('day');
    const ms = cur.toMillis();
    if (ms > toMs) break;
    if (ms < fromMs) continue;
    // Inside a collapsed gap there is no room for ticks (the gap marker labels it).
    if (scale.gaps.some((g) => ms > g.fromMs && ms < g.toMs)) continue;
    if (density === 'hour') {
      // The first moment of a local date is the day tick (also when DST skipped midnight).
      out.push(
        ms === cur.startOf('day').toMillis()
          ? { ms, label: dayLabel(cur), kind: 'day' }
          : { ms, label: cur.toFormat('h a'), kind: 'hour' },
      );
    } else if (density === 'day') {
      out.push({ ms, label: dayLabel(cur), kind: 'day' });
    } else {
      out.push({ ms, label: `Week of ${cur.toFormat('LLL d')}`, kind: 'week' });
    }
  }
  return out;
}

/** Default zoom. Read through `usePxPerHour()` (zoom.ts) so the zoom bead can drive it from one place. */
export const DEFAULT_PX_PER_HOUR = 48;

export type VisibleRange = { fromMs: number; toMs: number };

const ScaleContext = createContext<TimeScale | null>(null);
const VisibleContext = createContext<VisibleRange | null>(null);

/** Provided by `Timeline`. Side tracks (weather) position themselves with `useTimeScale().toY` only. */
export const TimeScaleProvider = ScaleContext.Provider;
export const VisibleRangeProvider = VisibleContext.Provider;

export function useTimeScale(): TimeScale {
  const s = useContext(ScaleContext);
  if (!s) throw new Error('useTimeScale must be used inside <Timeline>');
  return s;
}

/** Time range currently scrolled into view, rounded outward to whole hours (changes rarely while scrolling). */
export function useVisibleRange(): VisibleRange {
  const r = useContext(VisibleContext);
  if (!r) throw new Error('useVisibleRange must be used inside <Timeline>');
  return r;
}
