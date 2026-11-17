import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { geocode, isWeakMatch } from '../src/geo/geocode';
import type { Env } from '../src/env';
import { applyMigrations, makeTrip } from './helpers';
import vectors from '../../shared/test/vectors.json';

beforeAll(applyMigrations);
afterEach(() => vi.restoreAllMocks());

const withKey = { ...env, GOOGLE_MAPS_SERVER_KEY: 'k-secret' } as Env;
const noKey = { ...env, GOOGLE_MAPS_SERVER_KEY: undefined } as Env;

const place = (over: Record<string, unknown> = {}) => ({
  id: 'ChIJabc',
  displayName: { text: 'Hotel Avenida' },
  formattedAddress: 'Av. da Liberdade 1, Lisboa',
  location: { latitude: 38.72, longitude: -9.14 },
  types: ['lodging', 'establishment'],
  ...over,
});

function firstCall(spy: { mock: { calls: unknown[][] } }): [string, RequestInit] {
  const c = spy.mock.calls[0];
  if (!c) throw new Error('fetch not called');
  return [String(c[0]), (c[1] ?? {}) as RequestInit];
}

function mockFetch(body: unknown, status = 200) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify(body), { status }));
}

describe('geocode()', () => {
  test('fills lat/lng/placeId/address and sends key in header, not URL', async () => {
    const spy = mockFetch({ places: [place()] });
    const out = await geocode(withKey, { name: 'Hotel Avenida' });
    expect(out).toEqual({
      name: 'Hotel Avenida',
      address: 'Av. da Liberdade 1, Lisboa',
      lat: 38.72,
      lng: -9.14,
      placeId: 'ChIJabc',
    });
    const [url, init] = firstCall(spy);
    expect(String(url)).not.toContain('k-secret');
    const h = new Headers(init.headers);
    expect(h.get('x-goog-api-key')).toBe('k-secret');
    expect(h.get('x-goog-fieldmask')).toContain('places.location');
    expect(JSON.parse(init.body as string).textQuery).toBe('Hotel Avenida');
  });

  test('query joins name and address; existing address and name are kept', async () => {
    const spy = mockFetch({ places: [place()] });
    const out = await geocode(withKey, { name: 'My Hotel', address: 'Rua X' });
    expect(out.name).toBe('My Hotel');
    expect(out.address).toBe('Rua X');
    expect(out.lat).toBe(38.72);
    const body = JSON.parse(firstCall(spy)[1].body as string);
    expect(body.textQuery).toBe('My Hotel, Rua X');
  });

  test('no key: unchanged, no fetch', async () => {
    const spy = mockFetch({ places: [place()] });
    const loc = { name: 'Hotel Avenida' };
    expect(await geocode(noKey, loc)).toBe(loc);
    expect(spy).not.toHaveBeenCalled();
  });

  test('existing coordinates or empty query: no fetch', async () => {
    const spy = mockFetch({ places: [place()] });
    const a = { name: 'X', lat: 1, lng: 2 };
    expect(await geocode(withKey, a)).toBe(a);
    const b = { name: '  ' };
    expect(await geocode(withKey, b)).toBe(b);
    expect(spy).not.toHaveBeenCalled();
  });

  test('empty result, upstream error, bad JSON, network failure: unchanged', async () => {
    const loc = { name: 'Nowhere' };
    mockFetch({});
    expect(await geocode(withKey, loc)).toBe(loc);
    mockFetch({ error: 'denied' }, 403);
    expect(await geocode(withKey, loc)).toBe(loc);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json'));
    expect(await geocode(withKey, loc)).toBe(loc);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    expect(await geocode(withKey, loc)).toBe(loc);
  });

  test('weak match (city/country only) leaves input unchanged', async () => {
    mockFetch({ places: [place({ types: ['locality', 'political'] })] });
    const loc = { name: 'the hotel' };
    expect(await geocode(withKey, loc)).toBe(loc);
  });

  test('isWeakMatch', () => {
    expect(isWeakMatch(place())).toBe(false);
    expect(isWeakMatch(place({ types: ['country', 'political'] }))).toBe(true);
    expect(isWeakMatch(place({ types: ['locality', 'tourist_attraction'] }))).toBe(false);
    expect(isWeakMatch(place({ location: undefined }))).toBe(true);
    expect(isWeakMatch(place({ id: undefined }))).toBe(true);
  });
});

describe('GET /api/trips/:id/geocode', () => {
  const auth = { Authorization: `Bearer ${vectors.accessToken}` };
  const get = (id: string, q: string | null, headers: HeadersInit = auth) =>
    exports.default.fetch(
      `http://example.com/api/trips/${id}/geocode${q === null ? '' : `?q=${encodeURIComponent(q)}`}`,
      { headers },
    );
  const setKey = (k: string | undefined) => {
    (env as { GOOGLE_MAPS_SERVER_KEY?: string }).GOOGLE_MAPS_SERVER_KEY = k;
  };
  afterEach(() => setKey(undefined));

  test('401 without or with wrong token', async () => {
    const t = await makeTrip({ access_token_hash: vectors.accessTokenHash });
    expect((await get(t.id, 'lisbon', {})).status).toBe(401);
    expect((await get(t.id, 'lisbon', { Authorization: 'Bearer nope' })).status).toBe(401);
  });

  test('400 on missing, short or long q', async () => {
    const t = await makeTrip({ access_token_hash: vectors.accessTokenHash });
    expect((await get(t.id, null)).status).toBe(400);
    expect((await get(t.id, 'ab')).status).toBe(400);
    expect((await get(t.id, 'a'.repeat(201))).status).toBe(400);
  });

  test('no key: 200 with empty results and no fetch', async () => {
    const t = await makeTrip({ access_token_hash: vectors.accessTokenHash });
    const spy = mockFetch({ places: [place()] });
    const res = await get(t.id, 'lisbon hotel');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  test('with key: up to 5 results as Locations; upstream error gives []', async () => {
    const t = await makeTrip({ access_token_hash: vectors.accessTokenHash });
    setKey('k-secret');
    const spy = mockFetch({ places: Array.from({ length: 7 }, (_, i) => place({ id: `p${i}` })) });
    const res = await get(t.id, 'lisbon hotel');
    const { results } = (await res.json()) as { results: unknown[] };
    expect(results).toHaveLength(5);
    expect(results[0]).toEqual({
      name: 'Hotel Avenida',
      address: 'Av. da Liberdade 1, Lisboa',
      lat: 38.72,
      lng: -9.14,
      placeId: 'p0',
    });
    expect(JSON.parse(firstCall(spy)[1].body as string).pageSize).toBe(5);

    mockFetch({}, 500);
    expect(await (await get(t.id, 'lisbon hotel')).json()).toEqual({ results: [] });
  });
});
