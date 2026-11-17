import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  deriveTripKeys,
  encodeSecret,
  fold,
  fromBase64,
  generateSecret,
  openJson,
  sealJson,
  toBase64,
  type RecordBody,
  type StoredRecord,
} from '@planfully/shared';
import { ApiError } from '../lib/api';
import { compactTrip, type CompactApi } from './compact';
import { createTripStore, type TripApi } from './store';

const secret = generateSecret();
const fragment = '#' + encodeSecret(secret);
let keys: Awaited<ReturnType<typeof deriveTripKeys>>;
beforeEach(async () => {
  keys = await deriveTripKeys(secret);
});

const META = {
  id: 't1',
  name: 'T',
  address: 'a@b.c',
  domain: 'b.c',
  publicKey: 'x',
  roster: [],
  allowedSenders: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

function put(id: string): RecordBody {
  return {
    kind: 'put',
    event: {
      id,
      type: 'activity',
      name: 'Dinner',
      status: 'confirmed',
      attachments: [],
      participants: [],
      source: 'manual',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  };
}
const patch = (n: number): RecordBody => ({
  kind: 'patch',
  target: 'e1',
  fields: { name: `Dinner ${n}` },
});

async function stored(seq: number, body: RecordBody): Promise<StoredRecord> {
  return {
    seq,
    dedupe: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ciphertext: toBase64(await sealJson(keys.publicKey, body)),
  };
}

async function setup(bodies: RecordBody[]) {
  const recs = await Promise.all(bodies.map((b, i) => stored(i + 1, b)));
  const getRecords = vi
    .fn<TripApi['getRecords']>()
    .mockResolvedValue({ records: recs, latestSeq: recs.length, more: false });
  const calls: string[] = [];
  let next = 100;
  const postRecord = vi.fn<CompactApi['postRecord']>(async () => {
    calls.push('post');
    return { seq: next++ };
  });
  const deleteRecord = vi.fn<CompactApi['deleteRecord']>(async (_a, s) => {
    calls.push(`del${s}`);
  });
  const store = createTripStore({
    tripId: 't1',
    fragment,
    api: { getTrip: async () => META, getRecords }, // no write fns: the store's own trigger stays inert
  });
  store.start();
  await vi.waitFor(() => expect(store.getState().status).toBe('ready'));
  store.stop();
  return { store, postRecord, deleteRecord, calls };
}

describe('compactTrip', () => {
  test('5 records become 1; deletes follow the append; fold is identical', async () => {
    const t = await setup([put('e1'), patch(1), patch(2), patch(3), patch(4)]);
    const before = fold(t.store.getState().records);
    expect(await compactTrip(t.store, t, () => true)).toBe(true);
    expect(t.calls).toEqual(['post', 'del1', 'del2', 'del3', 'del4', 'del5']);
    const s = t.store.getState();
    expect(s.records.map((r) => r.seq)).toEqual([100]);
    expect(s.events).toEqual(before);
    expect(fold(s.records)).toEqual(before);
  });

  test('the appended record is sealed to the trip key and carries the folded event', async () => {
    const t = await setup([put('e1'), patch(1), patch(2), patch(3)]);
    await compactTrip(t.store, t, () => true);
    const arg = t.postRecord.mock.calls[0]?.[1];
    if (!arg) throw new Error('no post');
    const body = await openJson<RecordBody>(keys.privateKey, fromBase64(arg.ciphertext));
    expect(body.kind).toBe('put');
  });

  test('fold stays identical with old and new records both present', async () => {
    const t = await setup([put('e1'), patch(1), patch(2), patch(3)]);
    const before = fold(t.store.getState().records);
    t.deleteRecord.mockRejectedValue(new ApiError(500, 'boom'));
    await compactTrip(t.store, t, () => true);
    const s = t.store.getState();
    expect(s.records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 100]);
    expect(s.events).toEqual(before);
  });

  test('a failed append deletes nothing', async () => {
    const t = await setup([put('e1'), patch(1), patch(2), patch(3)]);
    t.postRecord.mockRejectedValue(new ApiError(500, 'boom'));
    expect(await compactTrip(t.store, t, () => true)).toBe(true);
    expect(t.deleteRecord).not.toHaveBeenCalled();
    expect(t.store.getState().records).toHaveLength(4);
  });

  test('a 404 on delete is fine', async () => {
    const t = await setup([put('e1'), patch(1), patch(2), patch(3)]);
    t.deleteRecord.mockRejectedValue(new ApiError(404, 'gone'));
    await compactTrip(t.store, t, () => true);
    expect(t.store.getState().records.map((r) => r.seq)).toEqual([100]);
  });

  test('fewer than 4 records: nothing happens', async () => {
    const t = await setup([put('e1'), patch(1), patch(2)]);
    await compactTrip(t.store, t, () => true);
    expect(t.postRecord).not.toHaveBeenCalled();
  });

  test('does not run offline or with writes pending', async () => {
    const t = await setup([put('e1'), patch(1), patch(2), patch(3)]);
    expect(await compactTrip(t.store, t, () => false)).toBe(false);
    t.store.getState().setWriteState({ pendingDelta: 1 });
    expect(await compactTrip(t.store, t, () => true)).toBe(false);
    expect(t.postRecord).not.toHaveBeenCalled();
  });

  test('temp records are never planned or deleted', async () => {
    const t = await setup([put('e1'), patch(1), patch(2), patch(3)]);
    // pending stays 0 on purpose: only the temp-seq filter protects it here
    const temp = t.store.getState().addOptimistic(patch(9));
    await compactTrip(t.store, t, () => true);
    expect(t.deleteRecord.mock.calls.map((c) => c[1])).toEqual([1, 2, 3, 4]);
    expect(t.store.getState().records.some((r) => r.seq === temp)).toBe(true);
  });

  test('stops before the append when a write starts after the first check', async () => {
    const t = await setup([put('e1'), patch(1), patch(2), patch(3)]);
    const orig = t.store.getState;
    let n = 0;
    vi.spyOn(t.store, 'getState').mockImplementation(() => {
      const s = orig();
      return ++n >= 2 ? { ...s, pending: 1 } : s;
    });
    await compactTrip(t.store, t, () => true);
    expect(t.postRecord).not.toHaveBeenCalled();
  });
});

describe('store trigger', () => {
  test('compacts once per session after the first successful sync', async () => {
    const recs = await Promise.all(
      [put('e1'), patch(1), patch(2), patch(3)].map((b, i) => stored(i + 1, b)),
    );
    const getRecords = vi
      .fn<TripApi['getRecords']>()
      .mockResolvedValue({ records: recs, latestSeq: 4, more: false });
    const postRecord = vi.fn<CompactApi['postRecord']>().mockResolvedValue({ seq: 9 });
    const deleteRecord = vi.fn<CompactApi['deleteRecord']>().mockResolvedValue(undefined);
    const store = createTripStore({
      tripId: 't1',
      fragment,
      api: { getTrip: async () => META, getRecords, postRecord, deleteRecord },
    });
    store.start();
    await vi.waitFor(() => expect(deleteRecord).toHaveBeenCalledTimes(4));
    await store.getState().sync();
    await store.getState().sync();
    store.stop();
    expect(postRecord).toHaveBeenCalledTimes(1);
  });
});
