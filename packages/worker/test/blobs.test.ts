import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, test } from 'vitest';
import { hashAccessToken } from '@planfully/shared';
import { BlobExistsError, getBlob, putBlob } from '../src/storage/blobs';
import { applyMigrations, makeTrip } from './helpers';

beforeAll(applyMigrations);

const BASE = 'http://example.com';
const url = (t: string, b: string) => `${BASE}/api/trips/${t}/blobs/${b}`;

async function trip(token: string) {
  const t = await makeTrip({ access_token_hash: await hashAccessToken(token) });
  return { id: t.id, auth: { Authorization: `Bearer ${token}` } };
}

const put = (u: string, headers: Record<string, string>, body: BodyInit | null) =>
  exports.default.fetch(u, { method: 'PUT', headers, body });

describe('blobs API', () => {
  test('PUT then GET returns identical 1 MB', async () => {
    const t = await trip('tok-a');
    const bytes = new Uint8Array(1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 255;
    const id = crypto.randomUUID();
    expect((await put(url(t.id, id), t.auth, bytes)).status).toBe(201);
    const res = await exports.default.fetch(url(t.id, id), { headers: t.auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test('second PUT to the same id is 409 and keeps the original', async () => {
    const t = await trip('tok-b');
    const id = crypto.randomUUID();
    expect((await put(url(t.id, id), t.auth, new Uint8Array([1, 2]))).status).toBe(201);
    expect((await put(url(t.id, id), t.auth, new Uint8Array([9]))).status).toBe(409);
    const res = await exports.default.fetch(url(t.id, id), { headers: t.auth });
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2]);
  });

  test('non-UUID id is 400', async () => {
    const t = await trip('tok-c');
    for (const bad of ['abc', '..%2F..%2Fx', 'not-a-uuid-at-all']) {
      expect((await put(url(t.id, bad), t.auth, new Uint8Array([1]))).status).toBe(400);
      expect((await exports.default.fetch(url(t.id, bad), { headers: t.auth })).status).toBe(400);
    }
  });

  test('401 without token or with another trip token', async () => {
    const a = await trip('tok-d');
    const b = await trip('tok-e');
    const id = crypto.randomUUID();
    expect((await put(url(a.id, id), {}, new Uint8Array([1]))).status).toBe(401);
    expect((await put(url(a.id, id), b.auth, new Uint8Array([1]))).status).toBe(401);
    expect((await exports.default.fetch(url(a.id, id), { headers: b.auth })).status).toBe(401);
  });

  test('missing is 404; another trip never sees the blob', async () => {
    const a = await trip('tok-f');
    const b = await trip('tok-g');
    const id = crypto.randomUUID();
    expect((await exports.default.fetch(url(a.id, id), { headers: a.auth })).status).toBe(404);
    await put(url(a.id, id), a.auth, new Uint8Array([7]));
    expect((await exports.default.fetch(url(b.id, id), { headers: b.auth })).status).toBe(404);
    expect(await getBlob(env, b.id, id)).toBeNull();
  });

  test('over the limit is 413 by Content-Length', async () => {
    const t = await trip('tok-h');
    const res = await put(
      url(t.id, crypto.randomUUID()),
      { ...t.auth, 'Content-Length': String(25 * 1024 * 1024 + 1) },
      new Uint8Array([1]),
    );
    expect(res.status).toBe(413);
  });

  test('a body longer than declared is rejected and nothing is stored', async () => {
    const t = await trip('tok-i');
    const id = crypto.randomUUID();
    const res = await put(url(t.id, id), { ...t.auth, 'Content-Length': '2' }, new Uint8Array(10));
    expect(res.status).not.toBe(201);
    expect(await getBlob(env, t.id, id)).toBeNull();
  });

  test('missing Content-Length is 411', async () => {
    const t = await trip('tok-j');
    const stream = new ReadableStream({
      start(ctl) {
        ctl.enqueue(new Uint8Array([1, 2, 3]));
        ctl.close();
      },
    });
    const res = await exports.default.fetch(url(t.id, crypto.randomUUID()), {
      method: 'PUT',
      headers: t.auth,
      body: stream,
      // @ts-expect-error duplex is required for stream bodies
      duplex: 'half',
    });
    expect(res.status).toBe(411);
  });
});

describe('putBlob / getBlob', () => {
  test('round trip, immutable, trip-scoped', async () => {
    const id = crypto.randomUUID();
    await putBlob(env, 'trip-x', id, new Uint8Array([4, 5]));
    await expect(putBlob(env, 'trip-x', id, new Uint8Array([6]))).rejects.toBeInstanceOf(
      BlobExistsError,
    );
    const s = await getBlob(env, 'trip-x', id);
    expect(Array.from(new Uint8Array(await new Response(s).arrayBuffer()))).toEqual([4, 5]);
    expect(await getBlob(env, 'trip-y', id)).toBeNull();
  });
});
