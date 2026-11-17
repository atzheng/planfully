import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as api from './api';

const auth = { tripId: 'abc', accessToken: 'tok' };
let fetchMock: ReturnType<typeof vi.fn>;

function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(
    new Response(body === undefined ? null : JSON.stringify(body), { status }),
  );
}
function call(): { url: string; init: RequestInit & { headers: Record<string, string> } } {
  const [url, init] = fetchMock.mock.calls[0] as [
    string,
    RequestInit & { headers: Record<string, string> },
  ];
  return { url, init };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

test('health: no auth header', async () => {
  reply({ ok: true });
  expect(await api.health()).toEqual({ ok: true });
  const { url, init } = call();
  expect(url).toBe('/api/health');
  expect(init.method).toBe('GET');
  expect(init.headers['Authorization']).toBeUndefined();
});

test('createTrip: POST with admin secret', async () => {
  reply({ id: 't', address: 'a@b', domain: 'b' }, 201);
  const body = { name: 'n', publicKey: 'k', accessTokenHash: 'h', roster: [], allowedSenders: [] };
  expect(await api.createTrip('admin', body)).toEqual({ id: 't', address: 'a@b', domain: 'b' });
  const { url, init } = call();
  expect(url).toBe('/api/trips');
  expect(init.method).toBe('POST');
  expect(init.headers['Authorization']).toBe('Bearer admin');
  expect(init.headers['Content-Type']).toBe('application/json');
  expect(JSON.parse(init.body as string)).toEqual(body);
});

test('getTrip', async () => {
  reply({ id: 'abc' });
  await api.getTrip(auth);
  const { url, init } = call();
  expect(url).toBe('/api/trips/abc');
  expect(init.method).toBe('GET');
  expect(init.headers['Authorization']).toBe('Bearer tok');
});

test('patchTrip', async () => {
  reply({ id: 'abc' });
  await api.patchTrip(auth, { name: 'New' });
  const { url, init } = call();
  expect(url).toBe('/api/trips/abc');
  expect(init.method).toBe('PATCH');
  expect(JSON.parse(init.body as string)).toEqual({ name: 'New' });
});

test('getRecords passes since and returns more', async () => {
  reply({ records: [], latestSeq: 0, more: true });
  const r = await api.getRecords(auth, 7);
  expect(r.more).toBe(true);
  expect(call().url).toBe('/api/trips/abc/records?since=7');
});

test('getRecords defaults since to 0', async () => {
  reply({ records: [], latestSeq: 0, more: false });
  await api.getRecords(auth);
  expect(call().url).toBe('/api/trips/abc/records?since=0');
});

test('postRecord', async () => {
  reply({ seq: 3 }, 201);
  expect(await api.postRecord(auth, { ciphertext: 'c', dedupe: 'd' })).toEqual({ seq: 3 });
  const { url, init } = call();
  expect(url).toBe('/api/trips/abc/records');
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body as string)).toEqual({ ciphertext: 'c', dedupe: 'd' });
});

test('deleteRecord handles 204', async () => {
  reply(undefined, 204);
  await api.deleteRecord(auth, 5);
  const { url, init } = call();
  expect(url).toBe('/api/trips/abc/records/5');
  expect(init.method).toBe('DELETE');
});

test('putBlob sends raw bytes', async () => {
  reply(undefined, 201);
  const bytes = new Uint8Array([1, 2, 3]);
  await api.putBlob(auth, 'b1', bytes);
  const { url, init } = call();
  expect(url).toBe('/api/trips/abc/blobs/b1');
  expect(init.method).toBe('PUT');
  expect(init.headers['Content-Type']).toBe('application/octet-stream');
  expect(init.body).toBe(bytes);
});

test('getBlob returns bytes', async () => {
  fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([9, 8])));
  expect(Array.from(await api.getBlob(auth, 'b1'))).toEqual([9, 8]);
  expect(call().url).toBe('/api/trips/abc/blobs/b1');
});

test('geocode encodes query', async () => {
  reply({ results: [{ name: 'x' }] });
  await api.geocode(auth, 'Paris & co');
  expect(call().url).toBe('/api/trips/abc/geocode?q=Paris%20%26%20co');
});

test('errors become ApiError with status and message', async () => {
  reply({ error: 'nope' }, 403);
  const err = await api.getTrip(auth).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(api.ApiError);
  expect((err as api.ApiError).status).toBe(403);
  expect((err as api.ApiError).message).toBe('nope');
});

test('non-JSON error body still throws ApiError', async () => {
  fetchMock.mockResolvedValueOnce(new Response('oops', { status: 502, statusText: 'Bad Gateway' }));
  const err = await api.health().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(api.ApiError);
  expect((err as api.ApiError).status).toBe(502);
});

test('requests never include a URL fragment', async () => {
  reply({ id: 'abc' });
  await api.getTrip(auth);
  expect(call().url).not.toContain('#');
});
