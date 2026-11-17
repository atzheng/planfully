import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import {
  deriveTripKeys,
  fold,
  encodeSecret,
  generateSecret,
  seal,
  sealJson,
  toBase64,
  type RecordBody,
  type StoredRecord,
  type TripMeta,
} from '@planfully/shared';
import { ApiError } from '../lib/api';
import { createTripStore, openRecords, type TripApi } from '../trip/store';
import { TEMP_SEQ_BASE } from '../trip/tempSeq';
import { fetchAttachment, prefetchAttachments } from '../trip/attachments';
import { createOfflineDb, setOfflineDb, type OfflineDb } from './db';
import { RecentTrips } from './RecentTrips';

const getBlobMock = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async (orig) => {
  const m = await orig<typeof import('../lib/api')>();
  return { ...m, getBlob: getBlobMock };
});

const META: TripMeta = {
  id: 't1',
  name: 'Lisbon',
  address: 'a@b.c',
  domain: 'b.c',
  publicKey: 'x',
  roster: [],
  allowedSenders: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const put = (id: string, name: string): RecordBody => ({
  kind: 'put',
  event: {
    id,
    type: 'activity',
    name,
    status: 'confirmed',
    attachments: [],
    participants: [],
    source: 'manual',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
});

const secret = generateSecret();
const frag = encodeSecret(secret);
let keys: Awaited<ReturnType<typeof deriveTripKeys>>;
let db: OfflineDb;
let n = 0;

beforeEach(async () => {
  keys = await deriveTripKeys(secret);
  db = createOfflineDb(`cache-${n++}`);
  setOfflineDb(db);
  getBlobMock.mockReset();
});
afterEach(() => {
  db.close();
  setOfflineDb(undefined);
});

async function stored(seq: number, body: unknown): Promise<StoredRecord> {
  return {
    seq,
    dedupe: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ciphertext: toBase64(await sealJson(keys.publicKey, body)),
  };
}

type Page = { records: StoredRecord[]; latestSeq: number; more: boolean };
function api(pages: Array<Page | Error>, extra: Partial<TripApi> = {}) {
  const getRecords = vi.fn<TripApi['getRecords']>();
  for (const p of pages) {
    if (p instanceof Error) getRecords.mockRejectedValueOnce(p);
    else getRecords.mockResolvedValueOnce(p);
  }
  const getTrip = vi.fn<TripApi['getTrip']>().mockResolvedValue(META);
  return { api: { getTrip, getRecords, ...extra } satisfies TripApi, getRecords, getTrip };
}

async function run(a: TripApi, fragment = '#' + frag) {
  const store = createTripStore({ tripId: 't1', fragment, api: a, cache: db });
  store.start();
  await vi.waitFor(() => expect(store.getState().status).not.toBe('loading'));
  return store;
}
const flush = () => new Promise((r) => setTimeout(r, 30));

describe('store cache', () => {
  test('round-trip: first load is cached; a new store shows it with no network, then syncs since lastSeq', async () => {
    const r1 = await stored(1, put('e1', 'Dinner'));
    const r2 = await stored(2, put('e2', 'Museum'));
    const first = api([{ records: [r1, r2], latestSeq: 7, more: false }]);
    const s1 = await run(first.api);
    await flush();
    s1.stop();
    expect(await db.getTrip('t1')).toMatchObject({ secret: frag, lastSeq: 7 });
    expect((await db.loadRecords('t1')).map((r) => r.seq)).toEqual([1, 2]);

    // Second session: the network is down.
    const second = api([new ApiError(0, 'down')]);
    second.getTrip.mockRejectedValue(new TypeError('offline'));
    const s2 = await run(second.api);
    s2.stop();
    const st = s2.getState();
    expect(st.status).toBe('ready');
    expect(st.events.map((e) => e.name).sort()).toEqual(['Dinner', 'Museum']);
    expect(st.cursor).toBe(7);
    expect(st.meta?.name).toBe('Lisbon');
    await vi.waitFor(() => expect(st.offline || s2.getState().offline).toBe(true));
    expect(s2.getState().error?.kind).toBe('network');
  });

  test('ordering: cached data renders before the network answers, then sync adds new records', async () => {
    const r1 = await stored(1, put('e1', 'Dinner'));
    const s1 = await run(api([{ records: [r1], latestSeq: 1, more: false }]).api);
    await flush();
    s1.stop();

    const r2 = await stored(2, put('e2', 'Museum'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const second = api([]);
    second.getRecords.mockImplementation(async () => {
      await gate;
      return { records: [r2], latestSeq: 2, more: false };
    });
    const s2 = createTripStore({ tripId: 't1', fragment: frag, api: second.api, cache: db });
    s2.start();
    await vi.waitFor(() => expect(s2.getState().status).toBe('ready'));
    expect(s2.getState().events.map((e) => e.name)).toEqual(['Dinner']);
    expect(second.getRecords).toHaveBeenCalledTimes(1);
    expect(second.getRecords.mock.calls[0]?.[1]).toBe(1);
    release();
    await vi.waitFor(() => expect(s2.getState().events).toHaveLength(2));
    await flush();
    s2.stop();
    expect((await db.loadRecords('t1')).map((r) => r.seq)).toEqual([1, 2]);
    expect((await db.getTrip('t1'))?.lastSeq).toBe(2);
    expect(second.getTrip).toHaveBeenCalled(); // meta refreshed after a cache load
  });

  test('lastSeq follows the cursor, not appended records; appended real records are cached, temp ones are not', async () => {
    const r1 = await stored(1, put('e1', 'Dinner'));
    const s = await run(api([{ records: [r1], latestSeq: 4, more: false }]).api);
    await flush();
    s.getState().append([{ seq: 9, dedupe: null, createdAt: 'x', body: put('e9', 'Own') }]);
    s.getState().addOptimistic(put('tmp', 'Temp'));
    await flush();
    s.stop();
    expect((await db.getTrip('t1'))?.lastSeq).toBe(4);
    expect((await db.loadRecords('t1')).map((r) => r.seq)).toEqual([1, 9]);
    expect((await db.loadRecords('t1')).every((r) => r.seq < TEMP_SEQ_BASE)).toBe(true);
  });

  test('removeRecords (compaction) is applied to the cache', async () => {
    const recs = [await stored(1, put('e1', 'A')), await stored(2, put('e2', 'B'))];
    const s = await run(api([{ records: recs, latestSeq: 2, more: false }]).api);
    await flush();
    s.getState().removeRecords([1]);
    await flush();
    s.stop();
    expect((await db.loadRecords('t1')).map((r) => r.seq)).toEqual([2]);
  });

  test('records that fail to open stay in the cache sealed and are counted as skipped', async () => {
    const good = await stored(1, put('e1', 'A'));
    const bad: StoredRecord = { ...good, seq: 2, ciphertext: toBase64(new Uint8Array(80)) };
    const s1 = await run(api([{ records: [good, bad], latestSeq: 2, more: false }]).api);
    await flush();
    s1.stop();
    expect((await db.loadRecords('t1')).map((r) => r.seq)).toEqual([1, 2]);
    const s2 = await run(api([{ records: [], latestSeq: 2, more: false }]).api);
    s2.stop();
    expect(s2.getState().skipped).toBe(1);
    expect(s2.getState().events).toHaveLength(1);
  });

  test('a different secret ignores the old cache and replaces it', async () => {
    const r1 = await stored(1, put('e1', 'Old'));
    const s1 = await run(api([{ records: [r1], latestSeq: 1, more: false }]).api);
    await flush();
    s1.stop();

    const secret2 = generateSecret();
    const keys2 = await deriveTripKeys(secret2);
    const r2: StoredRecord = {
      seq: 5,
      dedupe: null,
      createdAt: 'x',
      ciphertext: toBase64(await sealJson(keys2.publicKey, put('e2', 'New'))),
    };
    const second = api([{ records: [r2], latestSeq: 5, more: false }]);
    const s2 = await run(second.api, '#' + encodeSecret(secret2));
    await flush();
    s2.stop();
    expect(second.getRecords.mock.calls[0]?.[1]).toBe(0);
    expect(s2.getState().events.map((e) => e.name)).toEqual(['New']);
    expect((await db.loadRecords('t1')).map((r) => r.seq)).toEqual([5]);
    expect((await db.getTrip('t1'))?.secret).toBe(encodeSecret(secret2));
  });

  test('a stopped (replaced) store does not write to the cache', async () => {
    const r1 = await stored(1, put('e1', 'A'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = api([]);
    a.getRecords.mockImplementation(async () => {
      await gate;
      return { records: [r1], latestSeq: 1, more: false };
    });
    const store = createTripStore({ tripId: 't1', fragment: frag, api: a.api, cache: db });
    store.start();
    await vi.waitFor(() => expect(a.getRecords).toHaveBeenCalled());
    store.stop();
    release();
    await flush();
    expect(await db.getTrip('t1')).toBeUndefined();
  });

  test('a bad link or failed load stores no secret', async () => {
    await run(api([new ApiError(404, 'nope')]).api).then((s) => s.stop());
    expect(await db.listTrips()).toEqual([]);
  });

  test('works without a cache', async () => {
    const r1 = await stored(1, put('e1', 'A'));
    const a = api([{ records: [r1], latestSeq: 1, more: false }]);
    const store = createTripStore({ tripId: 't1', fragment: frag, api: a.api, cache: null });
    store.start();
    await vi.waitFor(() => expect(store.getState().status).toBe('ready'));
    store.stop();
  });
});

describe('attachment cache', () => {
  const att = (id: string, size = 10) => ({
    id,
    filename: 'f.pdf',
    mime: 'application/pdf',
    size,
    kind: 'file' as const,
  });

  test('fetchAttachment hits the network once, then the cache', async () => {
    await db.saveSnapshot({ tripId: 't1', secret: frag, meta: META, lastSeq: 0, records: [] });
    const sealed = await seal(keys.publicKey, new TextEncoder().encode('hello'));
    getBlobMock.mockResolvedValue(sealed);
    const ctx = { tripId: 't1', accessToken: keys.accessToken, privateKey: keys.privateKey };
    const b1 = await fetchAttachment(att('b1'), ctx);
    expect(await b1.text()).toBe('hello');
    getBlobMock.mockRejectedValue(new TypeError('offline'));
    const b2 = await fetchAttachment(att('b1'), ctx);
    expect(await b2.text()).toBe('hello');
    expect(getBlobMock).toHaveBeenCalledTimes(1);
    expect(await db.hasBlob('b1')).toBe(true);
  });

  test('prefetch caches small attachments only, skips cached, tolerates failures', async () => {
    await db.saveSnapshot({ tripId: 't1', secret: frag, meta: META, lastSeq: 0, records: [] });
    await db.putBlob('t1', 'have', new Uint8Array([1]));
    const fetchBlob = vi.fn(async (id: string) => {
      if (id === 'bad') throw new Error('x');
      return new Uint8Array([2]);
    });
    await prefetchAttachments(
      [att('have'), att('small'), att('big', 6 * 1024 * 1024), att('bad')],
      { tripId: 't1', accessToken: 'tok' },
      db,
      fetchBlob,
    );
    expect(fetchBlob.mock.calls.map((c) => c[0])).toEqual(['small', 'bad']);
    expect(await db.hasBlob('small')).toBe(true);
    expect(await db.hasBlob('big')).toBe(false);
  });

  test('the store prefetches small attachments after sync', async () => {
    const body = put('e1', 'A');
    if (body.kind === 'put') body.event.attachments = [att('pf1')];
    const r1 = await stored(1, body);
    const getBlob = vi.fn<NonNullable<TripApi['getBlob']>>().mockResolvedValue(new Uint8Array([9]));
    const s = await run(api([{ records: [r1], latestSeq: 1, more: false }], { getBlob }).api);
    await waitFor(async () => expect(await db.hasBlob('pf1')).toBe(true));
    s.stop();
    expect(getBlob).toHaveBeenCalledTimes(1);
  });
});

describe('review fixes', () => {
  test('compaction: the cache folds to the same events right after compacting', async () => {
    const recs = [
      await stored(1, put('e1', 'Dinner')),
      await stored(2, { kind: 'patch', target: 'e1', fields: { name: 'Dinner 2' } }),
      await stored(3, { kind: 'patch', target: 'e1', fields: { name: 'Dinner 3' } }),
      await stored(4, { kind: 'patch', target: 'e1', fields: { name: 'Dinner 4' } }),
    ];
    const postRecord = vi.fn(async () => ({ seq: 100 }));
    const deleteRecord = vi.fn(async () => undefined);
    const s = await run(
      api([{ records: recs, latestSeq: 4, more: false }], { postRecord, deleteRecord }).api,
    );
    await vi.waitFor(() => expect(deleteRecord).toHaveBeenCalledTimes(4));
    await flush();
    s.stop();
    expect(s.getState().events.map((e) => e.name)).toEqual(['Dinner 4']);
    const cached = await db.loadRecords('t1');
    expect(cached.map((r) => r.seq)).toEqual([100]);
    const { opened } = await openRecords(keys.privateKey, cached);
    expect(fold(opened)).toEqual(s.getState().events);
    expect((await db.getTrip('t1'))?.lastSeq).toBe(4);
  });

  test('a cached trip older than 7 days is fully reloaded, dropping stale records', async () => {
    const r1 = await stored(1, put('e1', 'Keep'));
    const r2 = await stored(2, put('e2', 'Stale'));
    await db.saveSnapshot({
      tripId: 't1',
      secret: frag,
      meta: META,
      lastSeq: 2,
      records: [r1, r2],
      replace: true,
    });
    const t = await db.getTrip('t1');
    if (!t) throw new Error('missing');
    await db.saveSnapshot({ tripId: 't1', meta: META, lastSeq: 2, records: [] });
    // age the full-load stamp
    const raw = await new Promise<IDBDatabase>((res) => {
      const q = indexedDB.open(`cache-${n - 1}`);
      q.onsuccess = () => res(q.result);
    });
    await new Promise<void>((res) => {
      const tx = raw.transaction('trips', 'readwrite');
      tx.objectStore('trips').put({ ...t, fullLoadAt: '2020-01-01T00:00:00.000Z' });
      tx.oncomplete = () => res();
    });
    raw.close();
    const a = api([{ records: [r1], latestSeq: 2, more: false }]);
    const s = await run(a.api);
    await vi.waitFor(() => expect(a.getRecords).toHaveBeenCalled());
    await vi.waitFor(() => expect(s.getState().events.map((e) => e.name)).toEqual(['Keep']));
    await flush();
    s.stop();
    expect(a.getRecords.mock.calls[0]?.[1]).toBe(0);
    expect((await db.loadRecords('t1')).map((r) => r.seq)).toEqual([1]);
  });

  test('a fresh cache is not fully reloaded', async () => {
    const r1 = await stored(1, put('e1', 'A'));
    await db.saveSnapshot({
      tripId: 't1',
      secret: frag,
      meta: META,
      lastSeq: 1,
      records: [r1],
      replace: true,
    });
    const a = api([{ records: [], latestSeq: 1, more: false }]);
    const s = await run(a.api);
    await vi.waitFor(() => expect(a.getRecords).toHaveBeenCalled());
    s.stop();
    expect(a.getRecords.mock.calls[0]?.[1]).toBe(1);
  });

  test('a 404 during sync keeps the cached data and flags the trip; a later success clears the flag', async () => {
    const r1 = await stored(1, put('e1', 'A'));
    await db.saveSnapshot({
      tripId: 't1',
      secret: frag,
      meta: META,
      lastSeq: 1,
      records: [r1],
      replace: true,
    });
    const s = await run(api([new ApiError(404, 'no')]).api);
    await vi.waitFor(() => expect(s.getState().status).toBe('error'));
    await flush();
    s.stop();
    expect((await db.getTrip('t1'))?.revokedAt).toBeTruthy();
    expect((await db.loadRecords('t1')).map((r) => r.seq)).toEqual([1]);

    const s2 = await run(api([{ records: [], latestSeq: 1, more: false }]).api);
    await vi.waitFor(() => expect(s2.getState().status).toBe('ready'));
    await vi.waitFor(async () => expect((await db.getTrip('t1'))?.revokedAt).toBeUndefined());
    s2.stop();
    expect((await db.loadRecords('t1')).map((r) => r.seq)).toEqual([1]);
  });

  test('putBlob for a forgotten trip is skipped (no orphan blobs)', async () => {
    await db.saveSnapshot({ tripId: 't1', secret: frag, meta: META, lastSeq: 0, records: [] });
    await db.putBlob('t1', 'b1', new Uint8Array([1]));
    await db.forgetTrip('t1');
    await db.putBlob('t1', 'b2', new Uint8Array([1]));
    expect(await db.hasBlob('b1')).toBe(false);
    expect(await db.hasBlob('b2')).toBe(false);
  });

  test('uploadAttachment puts the sealed bytes in the blob cache', async () => {
    await db.saveSnapshot({ tripId: 't1', secret: frag, meta: META, lastSeq: 0, records: [] });
    const { uploadAttachment } = await import('../trip/attachments');
    const putBlobMock = vi
      .spyOn(await import('../lib/api'), 'putBlob')
      .mockResolvedValue(undefined as never);
    const att = await uploadAttachment(new File(['hi'], 'a.txt', { type: 'text/plain' }), {
      tripId: 't1',
      accessToken: 'tok',
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    });
    expect(await db.hasBlob(att.id)).toBe(true);
    putBlobMock.mockRestore();
  });
});

describe('RecentTrips', () => {
  test('a refused link is labelled and can be forgotten', async () => {
    await db.saveSnapshot({
      tripId: 'a',
      secret: 'S',
      meta: { ...META, id: 'a', name: 'Alpha' },
      lastSeq: 1,
      records: [],
    });
    await db.markRevoked('a');
    const { unmount } = render(
      <MemoryRouter>
        <RecentTrips />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Link no longer works')).toBeTruthy();
    unmount();
  });

  const view = () =>
    render(
      <MemoryRouter>
        <RecentTrips />
      </MemoryRouter>,
    );

  test('renders nothing when there are no cached trips', async () => {
    const { container } = view();
    await flush();
    expect(container.textContent).toBe('');
  });

  test('lists trips with a link carrying the secret in the fragment; forget removes only that trip', async () => {
    await db.saveSnapshot({
      tripId: 'a',
      secret: 'SECRET-A',
      meta: { ...META, id: 'a', name: 'Alpha' },
      lastSeq: 1,
      records: [],
    });
    await db.saveSnapshot({
      tripId: 'b',
      secret: 'SECRET-B',
      meta: { ...META, id: 'b', name: 'Beta' },
      lastSeq: 1,
      records: [],
    });
    await db.putBlob('a', 'blob-a', new Uint8Array([1]));
    view();
    const link = await screen.findByRole('link', { name: /Alpha/ });
    expect(link.getAttribute('href')).toBe('/t/a#SECRET-A');
    expect(screen.getByText(/stored on this device in plain form/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Forget Alpha on this device' }));
    await waitFor(() => expect(screen.queryByText('Alpha')).toBeNull());
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(await db.getTrip('a')).toBeUndefined();
    expect(await db.hasBlob('blob-a')).toBe(false);
    expect((await db.getTrip('b'))?.secret).toBe('SECRET-B');
  });
});
