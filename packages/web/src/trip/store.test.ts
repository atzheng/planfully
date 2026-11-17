import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  deriveTripKeys,
  encodeSecret,
  generateSecret,
  sealJson,
  toBase64,
  type RecordBody,
  type StoredRecord,
} from '@planfully/shared';
import { ApiError } from '../lib/api';
import { createTripStore, MESSAGES, type TripApi } from './store';

const derive = vi.hoisted(() => ({ count: 0 }));
vi.mock('@planfully/shared', async (orig) => {
  const m = await orig<typeof import('@planfully/shared')>();
  return {
    ...m,
    deriveTripKeys: (s: Uint8Array) => {
      derive.count++;
      return m.deriveTripKeys(s);
    },
  };
});

const META = {
  id: 't1',
  name: 'Lisbon',
  address: 'a@b.c',
  domain: 'b.c',
  publicKey: 'x',
  roster: [],
  allowedSenders: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

function put(id: string, name: string): RecordBody {
  return {
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
  };
}

const secret = generateSecret();
const fragment = '#' + encodeSecret(secret);

let keys: Awaited<ReturnType<typeof deriveTripKeys>>;
beforeEach(async () => {
  keys = await deriveTripKeys(secret);
});

async function stored(seq: number, body: unknown): Promise<StoredRecord> {
  return {
    seq,
    dedupe: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ciphertext: toBase64(await sealJson(keys.publicKey, body)),
  };
}

function fakeApi(pages: Array<{ records: StoredRecord[]; latestSeq: number; more: boolean }>) {
  const getRecords = vi.fn<TripApi['getRecords']>();
  for (const p of pages) getRecords.mockResolvedValueOnce(p);
  const getTrip = vi.fn<TripApi['getTrip']>().mockResolvedValue(META);
  return { api: { getTrip, getRecords } satisfies TripApi, getRecords, getTrip };
}

async function ready(store: ReturnType<typeof createTripStore>) {
  store.start();
  await vi.waitFor(() => expect(store.getState().status).not.toBe('loading'));
}

afterEach(() => vi.useRealTimers());

describe('load', () => {
  test('folds sealed records to events, pages while more, authorises with the token', async () => {
    const r1 = await stored(1, put('e1', 'Dinner'));
    const r2 = await stored(2, put('e2', 'Museum'));
    const r3 = await stored(3, { kind: 'patch', target: 'e1', fields: { name: 'Late dinner' } });
    const { api, getRecords, getTrip } = fakeApi([
      { records: [r1, r2], latestSeq: 2, more: true },
      { records: [r3], latestSeq: 5, more: false },
    ]);
    const store = createTripStore({ tripId: 't1', fragment, api });
    await ready(store);
    store.stop();
    const s = store.getState();
    expect(s.status).toBe('ready');
    expect(s.meta?.name).toBe('Lisbon');
    expect(s.events.map((e) => e.name).sort()).toEqual(['Late dinner', 'Museum']);
    expect(s.records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(s.cursor).toBe(5);
    expect(getRecords.mock.calls.map((c) => c[1])).toEqual([0, 2]);
    expect(getTrip).toHaveBeenCalledWith({ tripId: 't1', accessToken: keys.accessToken });
    expect(s.keys?.accessToken).toBe(keys.accessToken);
  });

  test('skips and counts records that fail to open or validate', async () => {
    const good = await stored(1, put('e1', 'Dinner'));
    const garbage: StoredRecord = { ...good, seq: 2, ciphertext: toBase64(new Uint8Array(80)) };
    const invalid = await stored(3, { kind: 'bogus' });
    const { api } = fakeApi([{ records: [good, garbage, invalid], latestSeq: 3, more: false }]);
    const store = createTripStore({ tripId: 't1', fragment, api });
    await ready(store);
    store.stop();
    expect(store.getState().status).toBe('ready');
    expect(store.getState().events).toHaveLength(1);
    expect(store.getState().skipped).toBe(2);
  });
});

describe('errors', () => {
  test.each(['', '#', '#abc', '#' + 'A'.repeat(10)])('bad fragment %j', async (frag) => {
    const { api, getTrip } = fakeApi([]);
    const store = createTripStore({ tripId: 't1', fragment: frag, api });
    await ready(store);
    store.stop();
    expect(store.getState().status).toBe('error');
    expect(store.getState().error).toEqual({ kind: 'bad-link', message: MESSAGES.badLink });
    expect(getTrip).not.toHaveBeenCalled();
  });

  test('401 gives the wrong key error', async () => {
    const { api, getTrip } = fakeApi([]);
    getTrip.mockRejectedValue(new ApiError(401, 'unauthorized'));
    const store = createTripStore({ tripId: 't1', fragment, api });
    await ready(store);
    store.stop();
    expect(store.getState().status).toBe('error');
    expect(store.getState().error?.kind).toBe('unauthorized');
    expect(store.getState().error?.message).toBe('Trip not found or wrong key');
  });

  test('network failure on load retries with backoff', async () => {
    const r1 = await stored(1, put('e1', 'Dinner'));
    const { api, getTrip, getRecords } = fakeApi([{ records: [r1], latestSeq: 1, more: false }]);
    getTrip.mockRejectedValueOnce(new TypeError('offline'));
    const store = createTripStore({ tripId: 't1', fragment, api, backoffMs: [300] });
    store.start();
    await vi.waitFor(() => expect(store.getState().error?.kind).toBe('network'));
    expect(store.getState().status).toBe('error');
    await vi.waitFor(() => expect(store.getState().status).toBe('ready'));
    store.stop();
    expect(getRecords).toHaveBeenCalledTimes(1);
    expect(store.getState().events).toHaveLength(1);
  });
});

describe('sync', () => {
  test('appends only new records using since=cursor and re-folds', async () => {
    const r1 = await stored(1, put('e1', 'Dinner'));
    const r2 = await stored(2, put('e2', 'Museum'));
    const { api, getRecords } = fakeApi([
      { records: [r1], latestSeq: 1, more: false },
      { records: [r2], latestSeq: 2, more: false },
    ]);
    const store = createTripStore({ tripId: 't1', fragment, api });
    await ready(store);
    const before = store.getState().records;
    await store.getState().sync();
    store.stop();
    expect(getRecords.mock.calls.map((c) => c[1])).toEqual([0, 1]);
    expect(store.getState().events).toHaveLength(2);
    expect(store.getState().records.slice(0, 1)).toEqual(before);
    expect(store.getState().cursor).toBe(2);
  });

  test('does not re-fold when nothing changed', async () => {
    const r1 = await stored(1, put('e1', 'Dinner'));
    const { api } = fakeApi([
      { records: [r1], latestSeq: 1, more: false },
      { records: [], latestSeq: 1, more: false },
    ]);
    const store = createTripStore({ tripId: 't1', fragment, api });
    await ready(store);
    const events = store.getState().events;
    await store.getState().sync();
    store.stop();
    expect(store.getState().events).toBe(events);
  });

  test('network error keeps last data and records the error; recovers', async () => {
    const r1 = await stored(1, put('e1', 'Dinner'));
    const { api, getRecords } = fakeApi([{ records: [r1], latestSeq: 1, more: false }]);
    getRecords.mockRejectedValueOnce(new TypeError('offline'));
    getRecords.mockResolvedValueOnce({ records: [], latestSeq: 1, more: false });
    const store = createTripStore({ tripId: 't1', fragment, api });
    await ready(store);
    await store.getState().sync();
    expect(store.getState().status).toBe('ready');
    expect(store.getState().error?.kind).toBe('network');
    expect(store.getState().events).toHaveLength(1);
    await store.getState().sync();
    store.stop();
    expect(store.getState().error).toBeNull();
  });

  test('401 during sync becomes a fatal error', async () => {
    const r1 = await stored(1, put('e1', 'Dinner'));
    const { api, getRecords } = fakeApi([{ records: [r1], latestSeq: 1, more: false }]);
    getRecords.mockRejectedValueOnce(new ApiError(401, 'no'));
    const store = createTripStore({ tripId: 't1', fragment, api });
    await ready(store);
    await store.getState().sync();
    store.stop();
    expect(store.getState().status).toBe('error');
    expect(store.getState().error?.kind).toBe('unauthorized');
  });

  test('concurrent sync calls share one request', async () => {
    const { api, getRecords } = fakeApi([{ records: [], latestSeq: 0, more: false }]);
    const store = createTripStore({ tripId: 't1', fragment, api });
    await ready(store);
    getRecords.mockClear();
    getRecords.mockResolvedValue({ records: [], latestSeq: 0, more: false });
    await Promise.all([store.getState().sync(), store.getState().sync()]);
    store.stop();
    expect(getRecords).toHaveBeenCalledTimes(1);
  });

  test('polls on the interval and on focus', async () => {
    const { api, getRecords } = fakeApi([{ records: [], latestSeq: 0, more: false }]);
    getRecords.mockResolvedValue({ records: [], latestSeq: 0, more: false });
    const store = createTripStore({ tripId: 't1', fragment, api, intervalMs: 30 });
    await ready(store);
    getRecords.mockClear();
    await vi.waitFor(() => expect(getRecords).toHaveBeenCalled());
    store.stop();
    getRecords.mockClear();
    store.start();
    await vi.waitFor(() => expect(store.getState().status).toBe('ready'));
    getRecords.mockClear();
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(getRecords).toHaveBeenCalled());
    store.stop();
  });
});

describe('append', () => {
  test('merges written records, re-folds, dedupes by seq', async () => {
    const r1 = await stored(1, put('e1', 'Dinner'));
    const { api } = fakeApi([{ records: [r1], latestSeq: 1, more: false }]);
    const store = createTripStore({ tripId: 't1', fragment, api });
    await ready(store);
    store.stop();
    const added = {
      seq: 2,
      dedupe: null,
      createdAt: '2026-01-02T00:00:00.000Z',
      body: put('e2', 'Museum'),
    };
    store.getState().append([added]);
    store.getState().append([added]);
    expect(store.getState().records).toHaveLength(2);
    expect(store.getState().events).toHaveLength(2);
    expect(store.getState().cursor).toBe(1);
  });
});

describe('review fixes', () => {
  test('more:true with no progress stops and reports an error on load', async () => {
    const { api, getRecords } = fakeApi([]);
    getRecords.mockResolvedValue({ records: [], latestSeq: 0, more: true });
    const store = createTripStore({ tripId: 't1', fragment, api });
    await ready(store);
    store.stop();
    expect(getRecords.mock.calls.length).toBeLessThan(5);
    expect(store.getState().status).toBe('error');
    expect(store.getState().error?.kind).toBe('unknown');
  });

  test('stalled paging during sync keeps data and sets the error', async () => {
    const r1 = await stored(1, put('e1', 'Dinner'));
    const { api, getRecords } = fakeApi([{ records: [r1], latestSeq: 1, more: false }]);
    const store = createTripStore({ tripId: 't1', fragment, api });
    await ready(store);
    getRecords.mockClear();
    getRecords.mockResolvedValue({ records: [], latestSeq: 1, more: true });
    await store.getState().sync();
    store.stop();
    expect(getRecords).toHaveBeenCalledTimes(1);
    expect(store.getState().status).toBe('ready');
    expect(store.getState().events).toHaveLength(1);
    expect(store.getState().error?.kind).toBe('unknown');
  });

  test('records present but none open gives a terminal undecryptable error', async () => {
    const other = await deriveTripKeys(generateSecret());
    const foreign: StoredRecord = {
      seq: 1,
      dedupe: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      ciphertext: toBase64(await sealJson(other.publicKey, put('e1', 'X'))),
    };
    const { api } = fakeApi([{ records: [foreign], latestSeq: 1, more: false }]);
    const store = createTripStore({ tripId: 't1', fragment, api });
    await ready(store);
    store.stop();
    expect(store.getState().status).toBe('error');
    expect(store.getState().error?.kind).toBe('undecryptable');
    expect(store.getState().skipped).toBe(1);
  });

  test('429 and 5xx on initial load retry with backoff', async () => {
    for (const status of [429, 503]) {
      const r1 = await stored(1, put('e1', 'Dinner'));
      const { api, getTrip } = fakeApi([{ records: [r1], latestSeq: 1, more: false }]);
      getTrip.mockRejectedValueOnce(new ApiError(status, 'busy'));
      const store = createTripStore({ tripId: 't1', fragment, api, backoffMs: [300] });
      store.start();
      await vi.waitFor(() => expect(store.getState().error?.kind).toBe('network'));
      await vi.waitFor(() => expect(store.getState().status).toBe('ready'));
      store.stop();
    }
  });

  test('a no-change sync does not notify subscribers', async () => {
    const r1 = await stored(1, put('e1', 'Dinner'));
    const { api, getRecords } = fakeApi([{ records: [r1], latestSeq: 1, more: false }]);
    getRecords.mockResolvedValue({ records: [], latestSeq: 1, more: false });
    const store = createTripStore({ tripId: 't1', fragment, api });
    await ready(store);
    const listener = vi.fn();
    store.subscribe(listener);
    await store.getState().sync();
    store.stop();
    expect(listener).not.toHaveBeenCalled();
  });

  describe('hashchange', () => {
    afterEach(() => {
      window.location.hash = '';
    });

    test('a different secret calls onReplace; removal and same secret do not', async () => {
      const onReplace = vi.fn();
      const { api } = fakeApi([{ records: [], latestSeq: 0, more: false }]);
      window.location.hash = fragment;
      const store = createTripStore({ tripId: 't1', fragment, api, onReplace });
      await ready(store);

      window.location.hash = '';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      window.location.hash = fragment;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await new Promise((r) => setTimeout(r, 50));
      expect(onReplace).not.toHaveBeenCalled();
      expect(store.getState().status).toBe('ready');

      const next = '#' + encodeSecret(generateSecret());
      window.location.hash = next;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      await vi.waitFor(() => expect(onReplace).toHaveBeenCalledWith(next.slice(1)));
      store.stop();
    });
  });
});

test('start, stop, start (StrictMode) derives once and ends ready', async () => {
  const r1 = await stored(1, put('e1', 'Dinner'));
  const { api, getTrip } = fakeApi([{ records: [r1], latestSeq: 1, more: false }]);
  const store = createTripStore({ tripId: 't1', fragment, api });
  derive.count = 0;
  store.start();
  store.stop();
  store.start();
  await vi.waitFor(() => expect(store.getState().status).toBe('ready'));
  store.stop();
  expect(derive.count).toBe(1);
  expect(getTrip).toHaveBeenCalledTimes(1);
  expect(store.getState().events).toHaveLength(1);
});
