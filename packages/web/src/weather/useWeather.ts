import { useEffect, useMemo, useState } from 'react';
import { useTrip } from '../trip/store';
import { EMPTY_SERIES, fetchHourly, type HourlySeries } from './openMeteo';
import { HOUR_MS, hourlyLocations, type WeatherSegment } from './resolve';

/** 'empty' = loaded but no forecast for this segment (past, beyond the horizon, or no data). */
export type SegmentStatus = 'loading' | 'ready' | 'error' | 'empty';
export type WeatherStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SegmentWeather = {
  segment: WeatherSegment;
  series: HourlySeries;
  status: SegmentStatus;
};

const keyOf = (s: WeatherSegment) => `${s.fromMs}|${s.toMs}|${s.lat}|${s.lng}`;

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
  const [results, setResults] = useState<Record<string, { series: HourlySeries; failed: boolean }>>(
    {},
  );

  useEffect(() => {
    let stale = false;
    for (const segment of segments) {
      const key = keyOf(segment);
      fetchHourly(segment).then(
        (series) => {
          if (!stale) setResults((r) => ({ ...r, [key]: { series, failed: false } }));
        },
        () => {
          if (!stale) setResults((r) => ({ ...r, [key]: { series: EMPTY_SERIES, failed: true } }));
        },
      );
    }
    return () => {
      stale = true;
    };
  }, [segments]);

  return useMemo(() => {
    if (segments.length === 0) return { series: [], status: 'idle' as const };
    const series = segments.map((segment): SegmentWeather => {
      const r = results[keyOf(segment)];
      if (!r) return { segment, series: EMPTY_SERIES, status: 'loading' };
      if (r.failed) return { segment, series: r.series, status: 'error' };
      return { segment, series: r.series, status: r.series.timeMs.length ? 'ready' : 'empty' };
    });
    const status = series.some((s) => s.status === 'loading')
      ? 'loading'
      : series.some((s) => s.status === 'error')
        ? 'error'
        : 'ready';
    return { series, status };
  }, [segments, results]);
}
