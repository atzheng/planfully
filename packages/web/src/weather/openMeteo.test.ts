import { beforeEach, expect, test, vi } from 'vitest';
import { buildUrl, clampWindow, clearWeatherCache, fetchHourly } from './openMeteo';
import type { WeatherSegment } from './resolve';
import { convertTemp, defaultUnits, formatPrecip, formatTemp, formatWind } from './units';

const NOW = Date.parse('2026-06-10T12:00:00Z');
const seg = (from: string, to: string): WeatherSegment => ({
  fromMs: Date.parse(`${from}:00Z`),
  toMs: Date.parse(`${to}:00Z`),
  lat: 48.8566,
  lng: 2.3522,
  label: 'Paris',
});

const body = {
  hourly: {
    time: ['2026-06-11T00:00', '2026-06-11T01:00', '2026-06-11T02:00', '2026-06-11T03:00'],
    temperature_2m: [10, 11, null, 13],
    wind_speed_10m: [5, 6, 7, 8],
    precipitation: [0, 0.2, 0, 1],
  },
};

function mockFetch() {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

beforeEach(() => clearWeatherCache());

test('builds the expected URL', () => {
  const u = new URL(buildUrl(48.86, 2.35, '2026-06-11', '2026-06-12'));
  expect(u.origin + u.pathname).toBe('https://api.open-meteo.com/v1/forecast');
  expect(Object.fromEntries(u.searchParams)).toEqual({
    latitude: '48.86',
    longitude: '2.35',
    hourly: 'temperature_2m,wind_speed_10m,precipitation',
    wind_speed_unit: 'kmh',
    timezone: 'UTC',
    start_date: '2026-06-11',
    end_date: '2026-06-12',
  });
});

test('parses a response, restricts to the segment and drops null hours', async () => {
  const f = mockFetch();
  const out = await fetchHourly(seg('2026-06-11T00:00', '2026-06-11T03:00'), {
    nowMs: NOW,
    fetchFn: f as unknown as typeof fetch,
  });
  expect(f).toHaveBeenCalledTimes(1);
  const url = new URL((f.mock.calls[0] as unknown as [string])[0]);
  expect(url.searchParams.get('start_date')).toBe('2026-06-11');
  expect(url.searchParams.get('end_date')).toBe('2026-06-11');
  expect(out.timeMs).toEqual([
    Date.parse('2026-06-11T00:00:00Z'),
    Date.parse('2026-06-11T01:00:00Z'),
  ]);
  expect(out.tempC).toEqual([10, 11]);
  expect(out.windKph).toEqual([5, 6]);
  expect(out.precipMm).toEqual([0, 0.2]);
});

test('returns an empty series outside the forecast window without fetching', async () => {
  const f = mockFetch();
  const opts = { nowMs: NOW, fetchFn: f as unknown as typeof fetch };
  expect((await fetchHourly(seg('2026-06-01T00:00', '2026-06-02T00:00'), opts)).timeMs).toEqual([]);
  expect((await fetchHourly(seg('2026-07-01T00:00', '2026-07-02T00:00'), opts)).timeMs).toEqual([]);
  expect(f).not.toHaveBeenCalled();
});

test('clamps a straddling segment to today..today+15', () => {
  expect(clampWindow(seg('2026-06-05T00:00', '2026-07-20T00:00'), NOW)).toEqual({
    startDate: '2026-06-10',
    endDate: '2026-06-25',
  });
  expect(clampWindow(seg('2026-06-25T23:00', '2026-06-26T01:00'), NOW)).toEqual({
    startDate: '2026-06-25',
    endDate: '2026-06-25',
  });
});

test('a second identical call uses the cache; expires after 30 minutes', async () => {
  const f = mockFetch();
  const s = seg('2026-06-11T00:00', '2026-06-11T03:00');
  const o = (nowMs: number) => ({ nowMs, fetchFn: f as unknown as typeof fetch });
  await fetchHourly(s, o(NOW));
  await fetchHourly({ ...s, lat: 48.8569 }, o(NOW + 60_000)); // same rounded key
  expect(f).toHaveBeenCalledTimes(1);
  await fetchHourly(s, o(NOW + 31 * 60_000));
  expect(f).toHaveBeenCalledTimes(2);
});

test('HTTP errors reject', async () => {
  const f = vi.fn(async () => new Response('no', { status: 500 }));
  await expect(
    fetchHourly(seg('2026-06-11T00:00', '2026-06-11T03:00'), {
      nowMs: NOW,
      fetchFn: f as unknown as typeof fetch,
    }),
  ).rejects.toThrow();
});

test('units helpers', () => {
  expect(defaultUnits('en-US')).toEqual({ temp: 'F', wind: 'mph' });
  expect(defaultUnits('en-GB')).toEqual({ temp: 'C', wind: 'mph' });
  expect(defaultUnits('fr-FR')).toEqual({ temp: 'C', wind: 'kmh' });
  expect(convertTemp(100, 'F')).toBe(212);
  expect(formatTemp(20, 'F')).toBe('68°F');
  expect(formatWind(16.09344, 'mph')).toBe('10 mph');
  expect(formatWind(10, 'kmh')).toBe('10 km/h');
  expect(formatPrecip(25.4, 'F')).toBe('1.00 in');
});
