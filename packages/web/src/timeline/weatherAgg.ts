import { DateTime } from 'luxon';
import type { HourlySeries } from '../weather/openMeteo';
import { HOUR_MS, type WeatherSegment } from '../weather/resolve';
import { formatPrecip, formatTemp, formatWind, type Units } from '../weather/units';

export type Step = 'hour' | '3h' | 'day';

/** Smallest hour height (px) for hourly buckets; 3-hourly buckets are then >= 12px at 4 px/h. */
export const HOURLY_MIN_PX = 12;
export const THREE_HOURLY_MIN_PX = 4;

/** Aggregation level for a zoom: hourly when an hour is >= ~12px tall, then 3-hourly, then daily. */
export function stepFor(pxPerHour: number): Step {
  if (pxPerHour >= HOURLY_MIN_PX) return 'hour';
  if (pxPerHour >= THREE_HOURLY_MIN_PX) return '3h';
  return 'day';
}

export type Bucket = {
  fromMs: number;
  toMs: number;
  tempAvg: number;
  tempMin: number;
  tempMax: number;
  windAvg: number;
  windMax: number;
  precipSum: number;
  /** Hours with data in the bucket. */
  n: number;
  /** Set when several buckets were folded into one inside a collapsed gap (condensed time). */
  merged?: true;
  /** Merged buckets only: the largest rain total of any bucket folded in (what the rain scale and bar use). */
  precipPeak?: number;
};

export function bucketStart(ms: number, step: Step, zone: string): number {
  const dt = DateTime.fromMillis(ms, { zone });
  if (step === 'hour') return dt.startOf('hour').toMillis();
  if (step === '3h') {
    return dt
      .set({ hour: Math.floor(dt.hour / 3) * 3 })
      .startOf('hour')
      .toMillis();
  }
  return dt.startOf('day').toMillis();
}

export function bucketEnd(start: number, step: Step, zone: string): number {
  if (step === 'hour') return start + HOUR_MS;
  const dt = DateTime.fromMillis(start, { zone });
  const nextDay = dt.plus({ days: 1 }).startOf('day').toMillis();
  return step === '3h' ? Math.min(start + 3 * HOUR_MS, nextDay) : nextDay;
}

type Acc = Bucket & { tempSum: number; windSum: number };

/** Aggregate the hours of `series` that fall in `segment` into buckets of `step` (display zone `zone`). */
export function bucketize(
  series: HourlySeries,
  segment: { fromMs: number; toMs: number },
  step: Step,
  zone: string,
): Bucket[] {
  const acc = new Map<number, Acc>();
  for (let i = 0; i < series.timeMs.length; i++) {
    const t = series.timeMs[i];
    if (t === undefined) continue;
    if (t < segment.fromMs || t >= segment.toMs) continue;
    const temp = series.tempC[i];
    const wind = series.windKph[i];
    const rain = series.precipMm[i];
    if (temp === undefined || wind === undefined || rain === undefined) continue;
    const start = bucketStart(t, step, zone);
    let b = acc.get(start);
    if (!b) {
      b = {
        // Clipped to the segment so a mid-bucket place change does not make two overlapping buckets.
        fromMs: Math.max(start, segment.fromMs),
        toMs: Math.min(bucketEnd(start, step, zone), segment.toMs),
        tempAvg: 0,
        tempMin: Infinity,
        tempMax: -Infinity,
        windAvg: 0,
        windMax: -Infinity,
        precipSum: 0,
        n: 0,
        tempSum: 0,
        windSum: 0,
      };
      acc.set(start, b);
    }
    b.n++;
    b.tempSum += temp;
    b.windSum += wind;
    b.tempMin = Math.min(b.tempMin, temp);
    b.tempMax = Math.max(b.tempMax, temp);
    b.windMax = Math.max(b.windMax, wind);
    b.precipSum += rain;
  }
  return [...acc.values()]
    .sort((a, b) => a.fromMs - b.fromMs)
    .map(({ tempSum, windSum, ...b }) => ({
      ...b,
      tempAvg: tempSum / b.n,
      windAvg: windSum / b.n,
    }));
}

/** A collapsed stretch of the time axis with its drawn extent (a `ScaleGap`, structurally). */
export type YGap = { fromMs: number; toMs: number; fromY: number; toY: number };

/** Buckets drawn shorter than this many px are folded together (condensed time only). */
export const MIN_BUCKET_PX = 4;

/** True when `ms` is strictly inside one of the gaps. */
export function inGap(ms: number, gaps: readonly YGap[]): boolean {
  return gaps.some((g) => ms > g.fromMs && ms < g.toMs);
}

/**
 * Fold runs of adjacent buckets that lie inside one condensed gap and are drawn under
 * `MIN_BUCKET_PX` tall into a single bucket (averages weighted by hours, extremes kept, rain
 * summed), so the lines do not zigzag over a few px. With no gaps the input is returned as is.
 */
export function thinBuckets(
  buckets: readonly Bucket[],
  gaps: readonly YGap[],
  toY: (ms: number) => number,
): Bucket[] {
  if (gaps.length === 0) return [...buckets];
  const gapOf = (b: Bucket) =>
    toY(b.toMs) - toY(b.fromMs) < MIN_BUCKET_PX
      ? gaps.find((g) => b.fromMs >= g.fromMs && b.toMs <= g.toMs)
      : undefined;
  const out: Bucket[] = [];
  let runGap: YGap | undefined;
  for (const b of buckets) {
    const g = gapOf(b);
    const prev = out[out.length - 1];
    if (g && g === runGap && prev && prev.toMs === b.fromMs) {
      const n = prev.n + b.n;
      out[out.length - 1] = {
        fromMs: prev.fromMs,
        toMs: b.toMs,
        tempAvg: (prev.tempAvg * prev.n + b.tempAvg * b.n) / n,
        tempMin: Math.min(prev.tempMin, b.tempMin),
        tempMax: Math.max(prev.tempMax, b.tempMax),
        windAvg: (prev.windAvg * prev.n + b.windAvg * b.n) / n,
        windMax: Math.max(prev.windMax, b.windMax),
        precipSum: prev.precipSum + b.precipSum,
        n,
        precipPeak: Math.max(prev.precipPeak ?? prev.precipSum, b.precipPeak ?? b.precipSum),
        merged: true,
      };
    } else out.push(b);
    runGap = g;
  }
  return out;
}

export type BandKind = 'none' | 'error';
export type Band = { fromMs: number; toMs: number; kind: BandKind };
type Status = 'loading' | 'ready' | 'error' | 'empty';

/** The parts of a segment with no forecast: outside `coverage`, or all of it when there is none or the fetch failed. */
export function noForecastBands(
  segment: { fromMs: number; toMs: number },
  coverage: { fromMs: number; toMs: number } | null,
  status: Status,
): Band[] {
  if (status === 'loading') return [];
  if (status === 'error') return [{ ...segment, kind: 'error' }];
  if (!coverage || status === 'empty') return [{ ...segment, kind: 'none' }];
  const out: Band[] = [];
  if (coverage.fromMs > segment.fromMs)
    out.push({
      fromMs: segment.fromMs,
      toMs: Math.min(coverage.fromMs, segment.toMs),
      kind: 'none',
    });
  if (coverage.toMs < segment.toMs)
    out.push({
      fromMs: Math.max(coverage.toMs, segment.fromMs),
      toMs: segment.toMs,
      kind: 'none',
    });
  return out;
}

export type StripSegment = {
  segment: WeatherSegment;
  status: Status;
  buckets: Bucket[];
  /** Daily buckets (same as `buckets` at the daily step), for the per-day min/max labels. */
  days: Bucket[];
  bands: Band[];
};
export type DayLabel = { startMs: number; tempMin: number; tempMax: number };

/** One label per local day (across segments): the day's start, and min/max over every segment's hours. */
export function dayLabels(segments: readonly StripSegment[], zone: string): DayLabel[] {
  const m = new Map<number, DayLabel>();
  for (const s of segments)
    for (const d of s.days) {
      const startMs = bucketStart(d.fromMs, 'day', zone);
      const l = m.get(startMs);
      if (l) {
        l.tempMin = Math.min(l.tempMin, d.tempMin);
        l.tempMax = Math.max(l.tempMax, d.tempMax);
      } else m.set(startMs, { startMs, tempMin: d.tempMin, tempMax: d.tempMax });
    }
  return [...m.values()].sort((a, b) => a.startMs - b.startMs);
}

export type Extents = { tempMin: number; tempMax: number; windMax: number; precipMax: number };
export type SegmentInput = { segment: WeatherSegment; series: HourlySeries; status: Status };

export function buildStrip(
  input: readonly SegmentInput[],
  step: Step,
  zone: string,
  /** Condensed-time gaps and the scale's `toY`; omitted (or empty) for a linear axis. */
  gaps: readonly YGap[] = [],
  toY: (ms: number) => number = () => 0,
): { segments: StripSegment[]; extents: Extents } {
  const segments = input.map(({ segment, series, status }): StripSegment => {
    const buckets = thinBuckets(bucketize(series, segment, step, zone), gaps, toY);
    return {
      segment,
      status,
      buckets,
      days: step === 'day' ? buckets : bucketize(series, segment, 'day', zone),
      bands: noForecastBands(segment, series.coverage, status),
    };
  });
  const ex: Extents = { tempMin: Infinity, tempMax: -Infinity, windMax: 0, precipMax: 0 };
  for (const s of segments)
    for (const b of s.buckets) {
      ex.tempMin = Math.min(ex.tempMin, b.tempMin);
      ex.tempMax = Math.max(ex.tempMax, b.tempMax);
      ex.windMax = Math.max(ex.windMax, step === 'day' ? b.windMax : b.windAvg);
      ex.precipMax = Math.max(ex.precipMax, b.precipPeak ?? b.precipSum);
    }
  if (ex.tempMin > ex.tempMax) {
    ex.tempMin = 0;
    ex.tempMax = 1;
  }
  return { segments, extents: ex };
}

/** Scale ceilings so a quiet stretch is not stretched to full width. */
export function scaleMax(ex: Extents, step: Step): { wind: number; rain: number } {
  const rainFloor = step === 'hour' ? 2 : step === '3h' ? 4 : 10;
  return { wind: Math.max(ex.windMax, 20), rain: Math.max(ex.precipMax, rainFloor) };
}

export type Hit =
  | { kind: 'bucket'; place: string; bucket: Bucket }
  | { kind: 'none' | 'error' | 'loading'; place: string; atMs: number };

/** What lies under the instant `ms`: a bucket, or a no-forecast / failed / loading gap. Null outside every segment. */
export function hitAt(segments: readonly StripSegment[], ms: number): Hit | null {
  for (const s of segments) {
    if (ms < s.segment.fromMs || ms >= s.segment.toMs) continue;
    const b = s.buckets.find((x) => ms >= x.fromMs && ms < x.toMs);
    if (b) return { kind: 'bucket', place: s.segment.label, bucket: b };
    const kind = s.status === 'loading' ? 'loading' : s.status === 'error' ? 'error' : 'none';
    return { kind, place: s.segment.label, atMs: ms };
  }
  return null;
}

/** Plain-text readout for a hit (tooltip and screen readers). */
export function describeHit(hit: Hit, step: Step, zone: string, units: Units): string {
  const fmt = (ms: number, f: string) => DateTime.fromMillis(ms, { zone }).toFormat(f);
  const place = hit.place ? ` · ${hit.place}` : '';
  if (hit.kind !== 'bucket') {
    const what =
      hit.kind === 'error'
        ? 'Forecast unavailable'
        : hit.kind === 'loading'
          ? 'Loading forecast'
          : 'No forecast';
    return `${fmt(hit.atMs, 'ccc LLL d, h a')}${place}: ${what}`;
  }
  const b = hit.bucket;
  if (b.merged) {
    const range = `${fmt(b.fromMs, 'ccc LLL d, h a')} to ${fmt(b.toMs, 'ccc LLL d, h a')}`;
    return `${range}${place}: ${formatTemp(b.tempMin, units.temp)} to ${formatTemp(b.tempMax, units.temp)}, wind up to ${formatWind(b.windMax, units.wind)}, rain total ${formatPrecip(b.precipSum, units.temp)}`;
  }
  const when =
    step === 'day'
      ? fmt(b.fromMs, 'ccc LLL d')
      : step === '3h'
        ? `${fmt(b.fromMs, 'ccc LLL d, h a')} to ${fmt(b.toMs, 'h a')}`
        : fmt(b.fromMs, 'ccc LLL d, h a');
  const temp =
    step === 'hour'
      ? formatTemp(b.tempAvg, units.temp)
      : `${formatTemp(b.tempMin, units.temp)} to ${formatTemp(b.tempMax, units.temp)}`;
  const wind =
    step === 'day'
      ? `wind up to ${formatWind(b.windMax, units.wind)}`
      : `wind ${formatWind(b.windAvg, units.wind)}`;
  const rain = `${step === 'day' ? 'rain total' : 'rain'} ${formatPrecip(b.precipSum, units.temp)}`;
  return `${when}${place}: ${temp}, ${wind}, ${rain}`;
}

const DAY_MS = 24 * HOUR_MS;

/**
 * Range to fetch for a visible range: half a screen of margin each side, rounded out to whole UTC
 * days so scrolling changes the range (and so the requests) rarely.
 */
export function fetchRange(visible: { fromMs: number; toMs: number }): {
  fromMs: number;
  toMs: number;
} {
  const margin = (visible.toMs - visible.fromMs) / 2;
  return {
    fromMs: Math.floor((visible.fromMs - margin) / DAY_MS) * DAY_MS,
    toMs: Math.ceil((visible.toMs + margin) / DAY_MS) * DAY_MS,
  };
}
