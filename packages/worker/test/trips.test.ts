import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, test } from 'vitest';
import { app } from '../src/api/app';
import { getTripByAddress, getTripById, slugify } from '../src/db/trips';
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
    // authenticated passes the middleware (the stub router then 404s)
    expect((await call(`/api/trips/${t.id}/records`, { headers: auth })).status).toBe(404);
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
