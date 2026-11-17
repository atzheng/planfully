import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { StoredRecord, TripMeta } from '@planfully/shared';
import { TEMP_SEQ_BASE } from '../trip/tempSeq';
import { createOfflineDb, type OfflineDb } from './db';

const meta = (id: string, name = id): TripMeta => ({
  id,
  name,
  address: 'a@b.c',
  domain: 'b.c',
  publicKey: 'x',
  roster: [],
  allowedSenders: [],
  createdAt: '2026-01-01T00:00:00.000Z',
});
const rec = (seq: number): StoredRecord => ({
  seq,
  dedupe: null,
  ciphertext: `c${seq}`,
  createdAt: '2026-01-01T00:00:00.000Z',
});

let db: OfflineDb;
let n = 0;
beforeEach(() => {
  db = createOfflineDb(`test-${n++}`);
});
afterEach(() => db.close());

describe('offline db', () => {
  test('round-trips a trip, its sealed records and lastSeq', async () => {
    await db.saveSnapshot({
      tripId: 'a',
      secret: 'sec-a',
      meta: meta('a', 'Lisbon'),
      lastSeq: 9,
      records: [rec(2), rec(1)],
    });
    const t = await db.getTrip('a');
    expect(t).toMatchObject({ tripId: 'a', secret: 'sec-a', lastSeq: 9 });
    expect(t?.meta.name).toBe('Lisbon');
    expect((await db.loadRecords('a')).map((r) => r.seq)).toEqual([1, 2]);
    expect(await db.loadRecords('a')).toContainEqual(rec(1));
  });

  test('incremental snapshots add records; replace drops the old ones', async () => {
    await db.saveSnapshot({
      tripId: 'a',
      secret: 's',
      meta: meta('a'),
      lastSeq: 2,
      records: [rec(1), rec(2)],
    });
    await db.saveSnapshot({ tripId: 'a', meta: meta('a'), lastSeq: 5, records: [rec(3)] });
    expect((await db.loadRecords('a')).map((r) => r.seq)).toEqual([1, 2, 3]);
    expect((await db.getTrip('a'))?.secret).toBe('s');
    await db.saveSnapshot({
      tripId: 'a',
      meta: meta('a'),
      lastSeq: 7,
      records: [rec(7)],
      replace: true,
    });
    expect((await db.loadRecords('a')).map((r) => r.seq)).toEqual([7]);
  });

  test('an unknown trip without a secret is not stored', async () => {
    await db.saveSnapshot({ tripId: 'a', meta: meta('a'), lastSeq: 1, records: [rec(1)] });
    expect(await db.getTrip('a')).toBeUndefined();
    expect(await db.loadRecords('a')).toEqual([]);
  });

  test('a different secret replaces the cached records', async () => {
    await db.saveSnapshot({
      tripId: 'a',
      secret: 'old',
      meta: meta('a'),
      lastSeq: 1,
      records: [rec(1)],
    });
    await db.saveSnapshot({
      tripId: 'a',
      secret: 'new',
      meta: meta('a'),
      lastSeq: 4,
      records: [rec(4)],
    });
    expect((await db.loadRecords('a')).map((r) => r.seq)).toEqual([4]);
    expect((await db.getTrip('a'))?.secret).toBe('new');
  });

  test('temp records are never persisted', async () => {
    const temp = rec(TEMP_SEQ_BASE + 1);
    await db.saveSnapshot({
      tripId: 'a',
      secret: 's',
      meta: meta('a'),
      lastSeq: 1,
      records: [rec(1), temp],
    });
    expect((await db.loadRecords('a')).map((r) => r.seq)).toEqual([1]);
  });

  test('removeRecords deletes only the given seqs of that trip', async () => {
    await db.saveSnapshot({
      tripId: 'a',
      secret: 's',
      meta: meta('a'),
      lastSeq: 3,
      records: [rec(1), rec(2), rec(3)],
    });
    await db.saveSnapshot({
      tripId: 'b',
      secret: 's',
      meta: meta('b'),
      lastSeq: 3,
      records: [rec(1)],
    });
    await db.removeRecords('a', [1, 3]);
    expect((await db.loadRecords('a')).map((r) => r.seq)).toEqual([2]);
    expect((await db.loadRecords('b')).map((r) => r.seq)).toEqual([1]);
  });

  test('listTrips is most recently opened first; touch updates it', async () => {
    await db.saveSnapshot({
      tripId: 'a',
      secret: 's',
      meta: meta('a'),
      lastSeq: 0,
      records: [],
      openedAt: '2026-01-01T00:00:00.000Z',
    });
    await db.saveSnapshot({
      tripId: 'b',
      secret: 's',
      meta: meta('b'),
      lastSeq: 0,
      records: [],
      openedAt: '2026-02-01T00:00:00.000Z',
    });
    expect((await db.listTrips()).map((t) => t.tripId)).toEqual(['b', 'a']);
    await db.touch('a', '2026-03-01T00:00:00.000Z');
    expect((await db.listTrips()).map((t) => t.tripId)).toEqual(['a', 'b']);
  });

  test('forgetTrip removes that trip secret, records and blobs only', async () => {
    for (const id of ['a', 'b']) {
      await db.saveSnapshot({
        tripId: id,
        secret: `s-${id}`,
        meta: meta(id),
        lastSeq: 2,
        records: [rec(1), rec(2)],
      });
      await db.putBlob(id, `blob-${id}`, new Uint8Array([1, 2, 3]));
    }
    await db.forgetTrip('a');
    expect(await db.getTrip('a')).toBeUndefined();
    expect(await db.loadRecords('a')).toEqual([]);
    expect(await db.hasBlob('blob-a')).toBe(false);
    expect((await db.getTrip('b'))?.secret).toBe('s-b');
    expect((await db.loadRecords('b')).length).toBe(2);
    expect(await db.getBlob('blob-b')).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('queue store lists a trip in send order and forgetTrip clears it', async () => {
    const item = (tripId: string, kind: 'record' | 'blob') => ({
      tripId,
      kind,
      payload: new Uint8Array([1]),
      createdAt: 'x',
    });
    const a1 = await db.queueAdd(item('a', 'blob'));
    await db.queueAdd(item('b', 'record'));
    const a2 = await db.queueAdd(item('a', 'record'));
    expect((await db.queueList('a')).map((i) => i.id)).toEqual([a1, a2]);
    await db.queueRemove(a1);
    expect(await db.queueList('a')).toHaveLength(1);
    await db.forgetTrip('a');
    expect(await db.queueList('a')).toHaveLength(0);
    expect(await db.queueList('b')).toHaveLength(1);
  });
});
