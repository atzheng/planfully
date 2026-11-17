import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, test } from 'vitest';
import { appendRecord, deleteRecord, listRecords } from '../src/db/records';
import { getTripById } from '../src/db/trips';
import { applyMigrations, makeTrip } from './helpers';
import vectors from '../../shared/test/vectors.json';

beforeAll(applyMigrations);

const BASE = 'http://example.com';
const auth = { Authorization: `Bearer ${vectors.accessToken}` };
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

// makeTrip stores a placeholder token hash; give trips the real one so auth passes.
const trip = (over = {}) => makeTrip({ access_token_hash: vectors.accessTokenHash, ...over });

const call = (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const { json, ...rest } = init;
  const headers = new Headers({ ...auth, ...(rest.headers as Record<string, string>) });
  if (json !== undefined) headers.set('content-type', 'application/json');
  return exports.default.fetch(`${BASE}${path}`, {
    ...rest,
    headers,
    body: json === undefined ? rest.body : JSON.stringify(json),
  });
};
const post = (id: string, ct: string, dedupe?: string | null) =>
  call(`/api/trips/${id}/records`, { method: 'POST', json: { ciphertext: ct, dedupe } });

describe('appendRecord', () => {
  test('first seq is 1, then increasing; 20 concurrent appends are distinct and gap-free', async () => {
    const t = await trip();
    expect(await appendRecord(env, t.id, { ciphertext: new Uint8Array([1]) })).toBe(1);
    const seqs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendRecord(env, t.id, { ciphertext: new Uint8Array([i]) }),
      ),
    );
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));
    expect((await getTripById(env, t.id))?.nextSeq).toBe(21);
  });

  test('concurrent appends across trips do not interfere', async () => {
    const [a, b] = [await trip(), await trip()];
    const seqs = await Promise.all(
      [a, b, a, b, a, b].map((x) => appendRecord(env, x.id, { ciphertext: new Uint8Array([1]) })),
    );
    expect([...seqs].sort()).toEqual([1, 1, 2, 2, 3, 3]);
  });

  test('seq is not reused after deleting the highest', async () => {
    const t = await trip();
    await appendRecord(env, t.id, { ciphertext: new Uint8Array([1]) });
    const two = await appendRecord(env, t.id, { ciphertext: new Uint8Array([2]) });
    await deleteRecord(env, t.id, two);
    expect(await appendRecord(env, t.id, { ciphertext: new Uint8Array([3]) })).toBe(3);
    expect((await listRecords(env, t.id, 0)).map((r) => r.seq)).toEqual([1, 3]);
  });

  test('unknown trip throws and stores nothing', async () => {
    await expect(appendRecord(env, 'nope', { ciphertext: new Uint8Array([1]) })).rejects.toThrow();
    expect(await listRecords(env, 'nope', 0)).toEqual([]);
  });

  test('round-trips bytes and dedupe', async () => {
    const t = await trip();
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    await appendRecord(env, t.id, { ciphertext: bytes, dedupe: 'tag' });
    const [r] = await listRecords(env, t.id, 0);
    expect(r).toMatchObject({ seq: 1, dedupe: 'tag', ciphertext: b64(bytes) });
    expect(r?.createdAt).toMatch(/^\d{4}-/);
  });
});

type Page = {
  records: { seq: number; dedupe: string | null; ciphertext: string }[];
  latestSeq: number;
};

describe('records API', () => {
  test('POST 201 then GET returns it with latestSeq', async () => {
    const t = await trip();
    const res = await post(t.id, b64(new Uint8Array([1, 2, 3])), 'd');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ seq: 1 });
    const j = (await (await call(`/api/trips/${t.id}/records`)).json()) as Page;
    expect(j.latestSeq).toBe(1);
    expect(j.records).toHaveLength(1);
    expect(j.records[0]).toMatchObject({ seq: 1, dedupe: 'd', ciphertext: 'AQID' });
  });

  test('since filters, ascending; latestSeq survives a deleted tail', async () => {
    const t = await trip();
    for (let i = 0; i < 5; i++) await post(t.id, b64(new Uint8Array([i])));
    const get = async (q: string) =>
      (await (await call(`/api/trips/${t.id}/records${q}`)).json()) as Page;
    expect((await get('?since=2')).records.map((r) => r.seq)).toEqual([3, 4, 5]);
    expect((await get('?since=5')).records).toEqual([]);
    expect((await call(`/api/trips/${t.id}/records/5`, { method: 'DELETE' })).status).toBe(204);
    const after = await get('?since=3');
    expect(after.records.map((r) => r.seq)).toEqual([4]);
    expect(after.latestSeq).toBe(5);
    expect((await get('')).records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  test('400 on bad since', async () => {
    const t = await trip();
    for (const q of ['-1', 'abc', '1.5', '']) {
      expect((await call(`/api/trips/${t.id}/records?since=${q}`)).status).toBe(400);
    }
  });

  test('page cap: latestSeq is the last seq returned when truncated', async () => {
    const t = await trip();
    await env.DB.batch([
      ...Array.from({ length: 502 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO records (trip_id, seq, dedupe, ciphertext, created_at) VALUES (?, ?, NULL, x'00', 'x')",
        ).bind(t.id, i + 1),
      ),
      env.DB.prepare('UPDATE trips SET next_seq = 502 WHERE id = ?').bind(t.id),
    ]);
    const j = (await (await call(`/api/trips/${t.id}/records`)).json()) as Page;
    expect(j.records).toHaveLength(500);
    expect(j.latestSeq).toBe(500);
    const j2 = (await (await call(`/api/trips/${t.id}/records?since=500`)).json()) as Page;
    expect(j2.records).toHaveLength(2);
    expect(j2.latestSeq).toBe(502);
  });

  test('400 on invalid base64 and bad bodies', async () => {
    const t = await trip();
    for (const ct of ['not base64!', 'abc', '====']) {
      expect((await post(t.id, ct)).status).toBe(400);
    }
    for (const json of [
      {},
      { ciphertext: '' },
      { ciphertext: 'AQID', extra: 1 },
      { ciphertext: 5 },
    ]) {
      expect((await call(`/api/trips/${t.id}/records`, { method: 'POST', json })).status).toBe(400);
    }
    const bad = await call(`/api/trips/${t.id}/records`, { method: 'POST', body: 'nope' });
    expect(bad.status).toBe(400);
    expect((await listRecords(env, t.id, 0)).length).toBe(0);
  });

  test('256 KB is accepted, one byte more is 413', async () => {
    const t = await trip();
    expect((await post(t.id, b64(new Uint8Array(256 * 1024)))).status).toBe(201);
    expect((await post(t.id, b64(new Uint8Array(256 * 1024 + 1)))).status).toBe(413);
    expect((await post(t.id, b64(new Uint8Array(2 * 1024 * 1024)))).status).toBe(413);
  });

  test('DELETE is 204, also for a missing seq; bad seq is 400', async () => {
    const t = await trip();
    await post(t.id, 'AQID');
    expect((await call(`/api/trips/${t.id}/records/1`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/api/trips/${t.id}/records/1`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/api/trips/${t.id}/records/99`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`/api/trips/${t.id}/records/x`, { method: 'DELETE' })).status).toBe(400);
  });

  test("another trip's token cannot read or delete; trips are independent", async () => {
    const a = await trip();
    const b = await trip({ access_token_hash: 'b'.repeat(64) });
    await post(a.id, 'AQID');
    await appendRecord(env, b.id, { ciphertext: new Uint8Array([9]) });
    // Our token matches A only.
    expect((await call(`/api/trips/${b.id}/records`)).status).toBe(401);
    expect((await call(`/api/trips/${b.id}/records/1`, { method: 'DELETE' })).status).toBe(401);
    const foreign = { Authorization: 'Bearer something-else' };
    expect((await call(`/api/trips/${a.id}/records`, { headers: foreign })).status).toBe(401);
    expect(
      (await call(`/api/trips/${a.id}/records/1`, { method: 'DELETE', headers: foreign })).status,
    ).toBe(401);
    expect((await listRecords(env, a.id, 0)).length).toBe(1);
    expect((await listRecords(env, b.id, 0)).length).toBe(1);
    // Deleting A's seq 1 does not touch B's seq 1.
    await call(`/api/trips/${a.id}/records/1`, { method: 'DELETE' });
    expect((await listRecords(env, b.id, 0)).length).toBe(1);
  });
});
