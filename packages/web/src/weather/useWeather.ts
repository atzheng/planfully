import { useEffect, useMemo, useState } from 'react';
import { useTrip } from '../trip/store';
import {
  clampWindow,
  EMPTY_SERIES,
  fetchLocation,
  sliceSegment,
  type HourlySeries,
} from './openMeteo';
import { HOUR_MS, hourlyLocations, type WeatherSegment } from './resolve';

/** 'empty' = loaded but no forecast for this segment (past, beyond the horizon, or no data). */
export type SegmentStatus = 'loading' | 'ready' | 'error' | 'empty';
export type WeatherStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SegmentWeather = {
  segment: WeatherSegment;
  series: HourlySeries;
  status: SegmentStatus;
};

const locKey = (s: WeatherSegment) => `${s.lat},${s.lng}`;

/**
 * Weather for the hours in [fromMs, toMs) (rounded out to whole hours): one entry per location
 * segment, in time order, always for the current range (never a previous one). Each entry has its
 * own status and `series.coverage` (the part of the segment the forecast can cover).
 * Overall `status`: 'idle' when there are no located events (no segments), else 'loading' while any
 * segment loads, 'error' if any failed, otherwise 'ready'.
 */
export function useWeather(
  fromMs: number,
  toMs: number,
): { series: SegmentWeather[]; status: WeatherStatus } {
  const events = useTrip((s) => s.events);
  const from = Math.floor(fromMs / HOUR_MS) * HOUR_MS;
  const to = Math.ceil(toMs / HOUR_MS) * HOUR_MS;
  const segments = useMemo(() => hourlyLocations(events, from, to), [events, from, to]);
  /** Whole-window forecast per place; kept across range changes so scrolling never blanks the strip. */
  const [results, setResults] = useState<Record<string, { series: HourlySeries; failed: boolean }>>(
    {},
  );
  const [retry, setRetry] = useState(0);
  const nowMs = Date.now();
  const places = useMemo(() => {
    const m = new Map<string, WeatherSegment>();
    for (const seg of segments) if (clampWindow(seg, nowMs)) m.set(locKey(seg), seg);
    return m;
  }, [segments]);
  const placeKeys = [...places.keys()].join('|');

  useEffect(() => {
    let stale = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    for (const [key, seg] of places) {
      fetchLocation(seg.lat, seg.lng).then(
        (series) => {
          if (!stale) setResults((r) => ({ ...r, [key]: { series, failed: false } }));
        },
        () => {
          if (stale) return;
          setResults((r) => ({ ...r, [key]: { series: EMPTY_SERIES, failed: true } }));
          // Try again in a minute (the failure cache in openMeteo expires then).
          timer ??= setTimeout(() => setRetry((n) => n + 1), 61_000);
        },
      );
    }
    return () => {
      stale = true;
      if (timer) clearTimeout(timer);
    };
  }, [placeKeys, retry]);

  return useMemo(() => {
    if (segments.length === 0) return { series: [], status: 'idle' as const };
    const series = segments.map((segment): SegmentWeather => {
      if (!places.has(locKey(segment))) return { segment, series: EMPTY_SERIES, status: 'empty' };
      const r = results[locKey(segment)];
      if (!r) return { segment, series: EMPTY_SERIES, status: 'loading' };
      if (r.failed) return { segment, series: EMPTY_SERIES, status: 'error' };
      const sliced = sliceSegment(r.series, segment);
      return { segment, series: sliced, status: sliced.timeMs.length ? 'ready' : 'empty' };
    });
    const status = series.some((s) => s.status === 'loading')
      ? 'loading'
      : series.some((s) => s.status === 'error')
        ? 'error'
        : 'ready';
    return { series, status };
  }, [segments, results, places]);
}
