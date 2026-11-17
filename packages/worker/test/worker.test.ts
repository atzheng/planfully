import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, test } from 'vitest';
import { applyMigrations, makeTrip } from './helpers';

beforeAll(applyMigrations);

describe('api', () => {
  test('GET /api/health', async () => {
    const res = await exports.default.fetch('http://example.com/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('unknown /api path returns JSON 404', async () => {
    const res = await exports.default.fetch('http://example.com/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'not found' });
  });
});

describe('storage', () => {
  test('inserts and reads a trips row and a records row', async () => {
    const trip = await makeTrip({ name: 'Lisbon' });
    const read = await env.DB.prepare('SELECT * FROM trips WHERE id = ?').bind(trip.id).first();
    expect(read).toMatchObject({ id: trip.id, name: 'Lisbon', next_seq: 0 });

    const bytes = new Uint8Array([1, 2, 3]);
    await env.DB.prepare(
      'INSERT INTO records (trip_id, seq, dedupe, ciphertext, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(trip.id, 1, null, bytes, '2026-01-01T00:00:00.000Z')
      .run();
    const rec = await env.DB.prepare('SELECT * FROM records WHERE trip_id = ? AND seq = 1')
      .bind(trip.id)
      .first<{ ciphertext: number[]; dedupe: string | null }>();
    expect(rec?.dedupe).toBeNull();
    expect(Array.from(new Uint8Array(rec?.ciphertext ?? []))).toEqual([1, 2, 3]);
  });

  test('puts and gets an R2 object', async () => {
    await env.BLOBS.put('t/b', new Uint8Array([9, 8, 7]));
    const obj = await env.BLOBS.get('t/b');
    const buf = await obj?.arrayBuffer();
    expect(Array.from(new Uint8Array(buf ?? new ArrayBuffer(0)))).toEqual([9, 8, 7]);
  });
});
