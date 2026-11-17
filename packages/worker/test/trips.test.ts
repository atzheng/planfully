import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, test } from 'vitest';
import { app } from '../src/api/app';
import {
  createTrip,
  getTripByAddress,
  getTripById,
  isAddressCollision,
  slugify,
  updateTrip,
} from '../src/db/trips';
import { applyMigrations } from './helpers';
import vectors from '../../shared/test/vectors.json';

beforeAll(applyMigrations);

const BASE = 'http://example.com';
const ADMIN = { Authorization: 'Bearer test-admin-secret' };
const TOKEN = vectors.accessToken;
const auth = { Authorization: `Bearer ${TOKEN}` };
const publicKey = Buffer.from(vectors.publicKeyHex, 'hex').toString('base64url');

const body = (over: Record<string, unknown> = {}) => ({
  name: 'Lisbon & Porto 2026!',
  publicKey,
  accessTokenHash: vectors.accessTokenHash,
  roster: [{ id: 'a', name: 'Ann', aliases: ['A'] }],
  allowedSenders: [' Ann@Example.com '],
  ...over,
});

const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set('content-type', 'application/json');
  return exports.default.fetch(`${BASE}${path}`, {
    ...rest,
    headers,
    body: json === undefined ? rest.body : JSON.stringify(json),
  });
};

async function create(over: Record<string, unknown> = {}) {
  const res = await call('/api/trips', { method: 'POST', headers: ADMIN, json: body(over) });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; address: string; domain: string };
}

describe('POST /api/trips', () => {
  test('401 without or with wrong admin secret', async () => {
    expect((await call('/api/trips', { method: 'POST', json: body() })).status).toBe(401);
    const bad = await call('/api/trips', {
      method: 'POST',
      headers: { Authorization: 'Bearer nope' },
      json: body(),
    });
    expect(bad.status).toBe(401);
    // an access token is not the admin secret
    expect((await call('/api/trips', { method: 'POST', headers: auth, json: body() })).status).toBe(
      401,
    );
  });

  test('201 with id, address, domain; row stored', async () => {
    const t = await create();
    expect(t.domain).toBe(env.TRIP_DOMAIN);
    expect(t.id.length).toBeGreaterThanOrEqual(16);
    expect(t.address).toMatch(/^lisbon-porto-2026-[a-z0-9]{6}@trips\.example\.com$/);
    const row = await getTripById(env, t.id);
    expect(row).toMatchObject({
      name: 'Lisbon & Porto 2026!',
      address: t.address,
      publicKey,
      accessTokenHash: vectors.accessTokenHash,
      allowedSenders: ['ann@example.com'],
      nextSeq: 0,
    });
    expect(Buffer.from(row?.dedupeKey ?? '', 'base64').length).toBe(32);
  });

  test('refused when ADMIN_SECRET is unset', async () => {
    const res = await app.request(
      '/api/trips',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer undefined', 'content-type': 'application/json' },
        body: JSON.stringify(body()),
      },
      { ...env, ADMIN_SECRET: undefined as unknown as string },
    );
    expect(res.status).toBe(401);
  });

  test('400 on malformed input', async () => {
    for (const bad of [
      body({ name: '' }),
      body({ publicKey: 'short' }),
      body({ accessTokenHash: 'xyz' }),
      body({ roster: [{ id: 'a' }] }),
      body({ allowedSenders: 'a@b.c' }),
      body({ extra: 1 }),
    ]) {
      const res = await call('/api/trips', { method: 'POST', headers: ADMIN, json: bad });
      expect(res.status).toBe(400);
    }
    const res = await call('/api/trips', { method: 'POST', headers: ADMIN, body: 'not json' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/trips/:id', () => {
  test('returns TripMeta without secrets', async () => {
    const t = await create();
    const res = await call(`/api/trips/${t.id}`, { headers: auth });
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual([
      'address',
      'allowedSenders',
      'createdAt',
      'domain',
      'id',
      'name',
      'publicKey',
      'roster',
    ]);
    expect(meta).toMatchObject({
      id: t.id,
      address: t.address,
      domain: env.TRIP_DOMAIN,
      publicKey,
    });
    expect(JSON.stringify(meta)).not.toContain(vectors.accessTokenHash);
  });

  test('401 for wrong token, missing token and unknown trip', async () => {
    const t = await create();
    const wrong = await call(`/api/trips/${t.id}`, { headers: { Authorization: 'Bearer wrong' } });
    const none = await call(`/api/trips/${t.id}`);
    const unknown = await call('/api/trips/does-not-exist', { headers: auth });
    for (const r of [wrong, none, unknown]) expect(r.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  test('unauthenticated requests to sub-routers are 401', async () => {
    const t = await create();
    for (const sub of ['records', 'blobs/x', 'geocode?q=a']) {
      expect((await call(`/api/trips/${t.id}/${sub}`)).status).toBe(401);
      const wrong = await call(`/api/trips/${t.id}/${sub}`, {
        headers: { Authorization: 'Bearer wrong' },
      });
      expect(wrong.status).toBe(401);
    }
    expect((await call('/api/trips/does-not-exist/records')).status).toBe(401);
    // authenticated passes the middleware (an unrouted path then 404s)
    expect((await call(`/api/trips/${t.id}/nothing-here`, { headers: auth })).status).toBe(404);
  });
});

describe('PATCH /api/trips/:id', () => {
  test('updates roster, allowedSenders and name', async () => {
    const t = await create();
    const res = await call(`/api/trips/${t.id}`, {
      method: 'PATCH',
      headers: auth,
      json: {
        name: 'Renamed',
        roster: [{ id: 'b', name: 'Bob', aliases: [] }],
        allowedSenders: ['  X@Y.com', 'x@y.com', ''],
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: 'Renamed',
      roster: [{ id: 'b', name: 'Bob', aliases: [] }],
      allowedSenders: ['x@y.com'],
    });
    const again = await call(`/api/trips/${t.id}`, { headers: auth });
    expect(await again.json()).toMatchObject({ name: 'Renamed', allowedSenders: ['x@y.com'] });
  });

  test('partial patch keeps other fields', async () => {
    const t = await create();
    const res = await call(`/api/trips/${t.id}`, {
      method: 'PATCH',
      headers: auth,
      json: { allowedSenders: [] },
    });
    expect(await res.json()).toMatchObject({ allowedSenders: [], roster: [{ id: 'a' }] });
  });

  test('400 on malformed input, 401 without token', async () => {
    const t = await create();
    const bads = [
      { roster: 'x' },
      { roster: [{ id: 'a' }] },
      { allowedSenders: [1] },
      { name: '' },
      { accessTokenHash: 'a'.repeat(64) },
    ];
    for (const bad of bads) {
      const res = await call(`/api/trips/${t.id}`, { method: 'PATCH', headers: auth, json: bad });
      expect(res.status).toBe(400);
    }
    expect((await call(`/api/trips/${t.id}`, { method: 'PATCH', json: {} })).status).toBe(401);
  });
});

describe('db/trips', () => {
  test('getTripByAddress is case-insensitive', async () => {
    const t = await create();
    const row = await getTripByAddress(env, t.address.toUpperCase());
    expect(row?.id).toBe(t.id);
    expect(await getTripByAddress(env, 'nobody@trips.example.com')).toBeNull();
  });

  test('slugify', () => {
    expect(slugify('Café Ünïcode trip, very long name here')).toBe('cafe-unicode-trip-ve');
    expect(slugify('!!!')).toBe('trip');
  });
});

describe('createTrip retry', () => {
  const input = {
    name: 'Retry',
    publicKey,
    accessTokenHash: vectors.accessTokenHash,
    roster: [],
    allowedSenders: [],
  };
  /** Env whose DB.prepare(...).run() fails with the given errors in order, then succeeds. */
  const flaky = (errors: Error[]) => {
    let calls = 0;
    const fake = {
      ...env,
      DB: {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              const e = errors[calls++];
              if (e) throw e;
              return {};
            },
          }),
        }),
      },
    } as unknown as typeof env;
    return { fake, calls: () => calls };
  };

  test('real D1 UNIQUE violation on address is recognised', async () => {
    const t = await create();
    const row = await getTripById(env, t.id);
    const dup = env.DB.prepare(
      `INSERT INTO trips (id, address, name, public_key, access_token_hash, dedupe_key, allowed_senders, roster, next_seq, created_at)
       VALUES ('dup-id', ?, 'x', 'pk', 'h', 'd', '[]', '[]', 0, 'now')`,
    ).bind(row?.address);
    const err = await dup.run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(isAddressCollision(err)).toBe(true);
    // a collision on id is not an address collision
    const idDup = await env.DB.prepare(
      `INSERT INTO trips (id, address, name, public_key, access_token_hash, dedupe_key, allowed_senders, roster, next_seq, created_at)
       VALUES (?, 'other@x.com', 'x', 'pk', 'h', 'd', '[]', '[]', 0, 'now')`,
    )
      .bind(t.id)
      .run()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isAddressCollision(idDup)).toBe(false);
  });

  test('retries on address collision', async () => {
    const { fake, calls } = flaky([
      new Error('D1_ERROR: UNIQUE constraint failed: trips.address: SQLITE_CONSTRAINT'),
    ]);
    await createTrip(fake, input);
    expect(calls()).toBe(2);
  });

  test('other DB errors propagate immediately', async () => {
    const { fake, calls } = flaky([new Error('D1_ERROR: database is locked')]);
    await expect(createTrip(fake, input)).rejects.toThrow('database is locked');
    expect(calls()).toBe(1);
  });
});

describe('request body size cap', () => {
  const big = 'x'.repeat(70 * 1024);

  test('POST: 413 when Content-Length is over 64 KB', async () => {
    const res = await call('/api/trips', {
      method: 'POST',
      headers: ADMIN,
      json: body({ name: big }),
    });
    expect(res.status).toBe(413);
  });

  test('PATCH: 413 when Content-Length is over 64 KB', async () => {
    const t = await create();
    const res = await call(`/api/trips/${t.id}`, {
      method: 'PATCH',
      headers: auth,
      json: { name: big },
    });
    expect(res.status).toBe(413);
  });

  test('413 without Content-Length (streamed body)', async () => {
    const t = await create();
    const enc = new TextEncoder().encode(JSON.stringify({ name: big }));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < enc.length; i += 8192) c.enqueue(enc.slice(i, i + 8192));
        c.close();
      },
    });
    const req = new Request(`${BASE}/api/trips/${t.id}`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: stream,
      // @ts-expect-error duplex is required for streamed bodies
      duplex: 'half',
    });
    const res = await app.fetch(req, env);
    expect(res.status).toBe(413);
  });

  test('a normal body still passes', async () => {
    const t = await create();
    const res = await call(`/api/trips/${t.id}`, {
      method: 'PATCH',
      headers: auth,
      json: { name: 'ok' },
    });
    expect(res.status).toBe(200);
  });
});

describe('updateTrip', () => {
  test('writes only the provided columns', async () => {
    const t = await create();
    const roster = [{ id: 'z', name: 'Zed', aliases: [] }];
    // Simulate a concurrent writer changing the name between a stale read and our write.
    await env.DB.prepare('UPDATE trips SET name = ? WHERE id = ?').bind('Concurrent', t.id).run();
    const row = await updateTrip(env, t.id, { roster });
    expect(row?.name).toBe('Concurrent');
    expect(row?.roster).toEqual(roster);
    expect(row?.allowedSenders).toEqual(['ann@example.com']);
  });

  test('null for unknown trip; empty patch returns the row', async () => {
    expect(await updateTrip(env, 'nope', { name: 'x' })).toBeNull();
    const t = await create();
    expect((await updateTrip(env, t.id, {}))?.id).toBe(t.id);
  });
});
