import { HOUR_MS, type WeatherSegment } from './resolve';

export type HourlySeries = {
  timeMs: number[];
  tempC: number[];
  windKph: number[];
  precipMm: number[];
};

export const EMPTY_SERIES: HourlySeries = { timeMs: [], tempC: [], windKph: [], precipMm: [] };

export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
/** Open-Meteo allows up to 16 forecast days (today included) and 92 past days; we do not use the past. */
export const FORECAST_DAYS = 16;
export const CACHE_TTL_MS = 30 * 60_000;

const DAY_MS = 24 * HOUR_MS;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const startOfUtcDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

/**
 * Date range (UTC, inclusive) a segment can be fetched for: today through today + 15 days.
 * Returns null when the segment lies wholly outside it (past or beyond the horizon).
 */
export function clampWindow(
  seg: Pick<WeatherSegment, 'fromMs' | 'toMs'>,
  nowMs: number,
): { startDate: string; endDate: string } | null {
  const today = startOfUtcDay(nowMs);
  const lastDay = today + (FORECAST_DAYS - 1) * DAY_MS;
  const from = Math.max(startOfUtcDay(seg.fromMs), today);
  const to = Math.min(startOfUtcDay(seg.toMs - 1), lastDay);
  if (to < from) return null;
  return { startDate: isoDay(from), endDate: isoDay(to) };
}

export function buildUrl(lat: number, lng: number, startDate: string, endDate: string): string {
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    hourly: 'temperature_2m,wind_speed_10m,precipitation',
    wind_speed_unit: 'kmh',
    timezone: 'UTC',
    start_date: startDate,
    end_date: endDate,
  });
  return `${FORECAST_URL}?${q.toString()}`;
}

type Raw = {
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    wind_speed_10m?: (number | null)[];
    precipitation?: (number | null)[];
  };
};

/** Parse a response; hours with a null value are dropped. Times are UTC ('YYYY-MM-DDTHH:mm'). */
export function parseResponse(raw: Raw): HourlySeries {
  const h = raw.hourly;
  const out: HourlySeries = { timeMs: [], tempC: [], windKph: [], precipMm: [] };
  if (!h?.time) return out;
  h.time.forEach((t, i) => {
    const temp = h.temperature_2m?.[i];
    const wind = h.wind_speed_10m?.[i];
    const rain = h.precipitation?.[i];
    if (temp == null || wind == null || rain == null) return;
    const ms = Date.parse(`${t}:00Z`);
    if (!Number.isFinite(ms)) return;
    out.timeMs.push(ms);
    out.tempC.push(temp);
    out.windKph.push(wind);
    out.precipMm.push(rain);
  });
  return out;
}

const cache = new Map<string, { at: number; series: HourlySeries }>();
const inflight = new Map<string, Promise<HourlySeries>>();

export function clearWeatherCache(): void {
  cache.clear();
  inflight.clear();
}

export type FetchOpts = { nowMs?: number; fetchFn?: typeof fetch; signal?: AbortSignal };

/**
 * Hourly forecast for a segment, restricted to the segment's hours. Outside the forecast window
 * the result is an empty series, not an error. Network and HTTP errors reject.
 * Cached in memory by rounded lat/lng + date range for 30 minutes.
 */
export async function fetchHourly(
  seg: WeatherSegment,
  opts: FetchOpts = {},
): Promise<HourlySeries> {
  const now = opts.nowMs ?? Date.now();
  const win = clampWindow(seg, now);
  if (!win) return EMPTY_SERIES;
  const lat = Math.round(seg.lat * 100) / 100;
  const lng = Math.round(seg.lng * 100) / 100;
  const key = `${lat},${lng},${win.startDate},${win.endDate}`;
  const hit = cache.get(key);
  let full: HourlySeries;
  if (hit && now - hit.at < CACHE_TTL_MS) {
    full = hit.series;
  } else {
    let p = inflight.get(key);
    if (!p) {
      const f = opts.fetchFn ?? fetch;
      p = (async () => {
        const res = await f(buildUrl(lat, lng, win.startDate, win.endDate), {
          signal: opts.signal,
        });
        if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
        const series = parseResponse((await res.json()) as Raw);
        cache.set(key, { at: now, series });
        return series;
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    full = await p;
  }
  const out: HourlySeries = { timeMs: [], tempC: [], windKph: [], precipMm: [] };
  full.timeMs.forEach((t, i) => {
    if (t < seg.fromMs || t >= seg.toMs) return;
    out.timeMs.push(t);
    out.tempC.push(full.tempC[i] as number);
    out.windKph.push(full.windKph[i] as number);
    out.precipMm.push(full.precipMm[i] as number);
  });
  return out;
}
