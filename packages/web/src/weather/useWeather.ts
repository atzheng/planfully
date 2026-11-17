import { useEffect, useMemo, useState } from 'react';
import { useTrip } from '../trip/store';
import { EMPTY_SERIES, fetchHourly, type HourlySeries } from './openMeteo';
import { hourlyLocations, type WeatherSegment } from './resolve';

export type WeatherStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SegmentWeather = { segment: WeatherSegment; series: HourlySeries };

/**
 * Weather for the hours in [fromMs, toMs): one entry per location segment, in time order.
 * Segments outside the forecast window have an empty series (a gap). `status` is 'error' when any
 * request failed (those segments get an empty series; the others are still returned).
 */
export function useWeather(
  fromMs: number,
  toMs: number,
): { series: SegmentWeather[]; status: WeatherStatus } {
  const events = useTrip((s) => s.events);
  const segments = useMemo(() => hourlyLocations(events, fromMs, toMs), [events, fromMs, toMs]);
  const [state, setState] = useState<{
    for: WeatherSegment[];
    series: SegmentWeather[];
    status: WeatherStatus;
  }>({ for: [], series: [], status: 'idle' });

  useEffect(() => {
    if (segments.length === 0) return;
    const ctl = new AbortController();
    let failed = false;
    void Promise.all(
      segments.map(async (segment): Promise<SegmentWeather> => {
        try {
          return { segment, series: await fetchHourly(segment, { signal: ctl.signal }) };
        } catch {
          failed = true;
          return { segment, series: EMPTY_SERIES };
        }
      }),
    ).then((series) => {
      if (ctl.signal.aborted) return;
      setState({ for: segments, series, status: failed ? 'error' : 'ready' });
    });
    return () => ctl.abort();
  }, [segments]);

  if (segments.length === 0) return { series: [], status: 'idle' };
  if (state.for !== segments) return { series: state.series, status: 'loading' };
  return { series: state.series, status: state.status };
}
