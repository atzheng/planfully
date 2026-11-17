import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  deriveTripKeys,
  encodeSecret,
  fold,
  fromBase64,
  generateSecret,
  openJson,
  type OpenedRecord,
  type RecordBody,
} from '@planfully/shared';
import { ApiError } from '../lib/api';
import { createTripActions } from '../trip/actions';
import { compactTrip } from '../trip/compact';
import { createTripStore } from '../trip/store';
import { uploadAttachment } from '../trip/attachments';
import { createOfflineDb, type OfflineDb } from './db';
import { openDB } from 'idb';
import { createTripQueue, dbQueueStorage, resilientQueueStorage, type QueueApi } from './queue';

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

const secret = generateSecret();
const fragment = '#' + encodeSecret(secret);
let keys: Awaited<ReturnType<typeof deriveTripKeys>>;
let db: OfflineDb;
let n = 0;
beforeEach(async () => {
  keys = await deriveTripKeys(secret);
  db = createOfflineDb(`queue-test-${n++}`);
});
afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A server double: records what was posted/put in order; `down` makes everything fail. */
function fakeServer() {
  const log: string[] = [];
  const posted: RecordBody[] = [];
  let seq = 0;
  const state = { down: false, refuse: null as null | ((b: RecordBody) => boolean) };
  const postRecord = vi.fn(async (_a: unknown, req: { ciphertext: string }) => {
    if (state.down) throw new TypeError('Failed to fetch');
    const body = await openJson<RecordBody>(keys.privateKey, fromBase64(req.ciphertext));
    if (state.refuse?.(body)) throw new ApiError(400, 'refused');
    posted.push(body);
    log.push(`record:${body.kind}`);
    return { seq: ++seq };
  });
  const putBlob = vi.fn(async (_a: unknown, id: string) => {
    if (state.down) throw new TypeError('Failed to fetch');
    log.push(`blob:${id}`);
  });
  return {
    api: { postRecord, putBlob } as unknown as QueueApi,
    postRecord,
    putBlob,
    log,
    posted,
    state,
  };
}

async function session(api: QueueApi) {
  const store = createTripStore({
    tripId: 't1',
    fragment,
    cache: null,
    intervalMs: 1e9,
    api: {
      getTrip: vi.fn().mockResolvedValue(META),
      getRecords: vi.fn().mockResolvedValue({ records: [], latestSeq: 0, more: false }),
    },
  });
  store.start();
  await vi.waitFor(() => expect(store.getState().status).toBe('ready'));
  const queue = createTripQueue(store, { api, storage: dbQueueStorage(db), backoffMs: [10] });
  const actions = createTripActions(store, { queue });
  return { store, queue, actions };
}

const names = (s: { getState(): { events: { name: string }[] } }) =>
  s.getState().events.map((e) => e.name);

describe('offline edit queue', () => {
  test('an offline edit is visible at once and stays queued (no rollback, no error)', async () => {
    const srv = fakeServer();
    srv.state.down = true;
    const { store, queue, actions } = await session(srv.api);
    await actions.putEvent({ name: 'Dinner', type: 'activity' });
    expect(names(store)).toEqual(['Dinner']);
    const s = store.getState();
    expect(s.pending).toBe(1);
    expect(s.queueStalled).toBe(true);
    expect(s.lastError).toBeNull();
    expect(await db.queueList('t1')).toHaveLength(1);
    queue.stop();
  });

  test('queued payloads are sealed, never plaintext', async () => {
    const srv = fakeServer();
    srv.state.down = true;
    const { actions } = await session(srv.api);
    await actions.putEvent({ name: 'Secret dinner name', type: 'activity' });
    const [item] = await db.queueList('t1');
    const text = new TextDecoder('latin1').decode(item?.payload);
    expect(text).not.toContain('Secret dinner name');
    expect(item?.payload).toBeInstanceOf(Uint8Array);
  });

  test('survives a restart: reopened, shown, then flushed in order', async () => {
    const srv = fakeServer();
    srv.state.down = true;
    const first = await session(srv.api);
    await first.actions.putEvent({ name: 'A', type: 'activity' });
    const id = first.store.getState().events[0]?.id as string;
    await first.actions.patchEvent(id, { name: 'B' });
    first.queue.stop();
    first.store.stop();

    // New store and queue over the same IndexedDB: the app restarted while offline.
    const second = await session(srv.api);
    second.queue.start();
    await vi.waitFor(() => expect(names(second.store)).toEqual(['B']));
    expect(second.store.getState().pending).toBe(2);
    expect(await db.queueList('t1')).toHaveLength(2);

    srv.state.down = false;
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(second.store.getState().pending).toBe(0));
    expect(srv.log).toEqual(['record:put', 'record:patch']);
    expect(await db.queueList('t1')).toHaveLength(0);
    expect(second.store.getState().queueStalled).toBe(false);
    expect(second.store.getState().records.map((r) => r.seq)).toEqual([1, 2]);
    expect(names(second.store)).toEqual(['B']);
    second.queue.stop();
  });

  test('retries with backoff and flushes once the network is back', async () => {
    const srv = fakeServer();
    srv.state.down = true;
    const { store, queue, actions } = await session(srv.api);
    queue.start();
    await actions.putEvent({ name: 'A', type: 'activity' });
    await new Promise((r) => setTimeout(r, 60)); // backoff retries fail quietly
    expect(srv.postRecord.mock.calls.length).toBeGreaterThan(1);
    expect(store.getState().pending).toBe(1);
    srv.state.down = false;
    await vi.waitFor(() => expect(store.getState().pending).toBe(0), { timeout: 2000 });
    expect(srv.log).toEqual(['record:put']);
    queue.stop();
  });

  test('a blob is sent before the record that references it', async () => {
    const srv = fakeServer();
    srv.state.down = true;
    const { store, queue, actions } = await session(srv.api);
    const file = new File([new Uint8Array([1, 2, 3])], 'pass.pdf', { type: 'application/pdf' });
    const att = await uploadAttachment(file, { tripId: 't1', ...keys, queue });
    await actions.putEvent({ name: 'Receipt', type: 'receipt', attachments: [att] });
    expect((await db.queueList('t1')).map((i) => i.kind)).toEqual(['blob', 'record']);
    srv.state.down = false;
    await queue.flush();
    expect(srv.log).toEqual([`blob:${att.id}`, 'record:put']);
    expect(store.getState().pending).toBe(0);
  });

  test('a 4xx drops the item, rolls it back and reports it; later items still go', async () => {
    const srv = fakeServer();
    srv.state.refuse = (b) => b.kind === 'put' && b.event.name === 'Bad';
    const { store, actions } = await session(srv.api);
    await expect(actions.putEvent({ name: 'Bad', type: 'activity' })).rejects.toThrow('refused');
    await actions.putEvent({ name: 'Good', type: 'activity' });
    expect(names(store)).toEqual(['Good']);
    expect(store.getState().lastError?.message).toBe('refused');
    expect(store.getState().pending).toBe(0);
    expect(await db.queueList('t1')).toHaveLength(0);
  });

  test('a dropped put takes its queued patch with it, even across a restart', async () => {
    const srv = fakeServer();
    srv.state.down = true;
    const first = await session(srv.api);
    await first.actions.putEvent({ name: 'Bad', type: 'activity' });
    const id = first.store.getState().events[0]?.id as string;
    await first.actions.patchEvent(id, { name: 'Worse' });
    await first.actions.putEvent({ name: 'Fine', type: 'activity' });
    first.queue.stop();
    first.store.stop();

    srv.state.down = false;
    srv.state.refuse = (b) => b.kind === 'put' && b.event.name === 'Bad';
    const second = await session(srv.api);
    second.queue.start();
    await vi.waitFor(async () => expect(await db.queueList('t1')).toHaveLength(0));
    await vi.waitFor(() => expect(second.store.getState().pending).toBe(0));
    expect(srv.posted.map((b) => b.kind)).toEqual(['put']);
    expect(names(second.store)).toEqual(['Fine']);
    expect(second.store.getState().lastError?.message).toBe('refused');
    expect(await db.queueList('t1')).toHaveLength(0);
    second.queue.stop();
  });

  test('a dropped blob drops the record that references it', async () => {
    const srv = fakeServer();
    srv.state.down = true;
    const { store, queue, actions } = await session(srv.api);
    const file = new File([new Uint8Array([1])], 'a.pdf');
    const att = await uploadAttachment(file, { tripId: 't1', ...keys, queue });
    await actions.putEvent({ name: 'R', type: 'receipt', attachments: [att] });
    srv.state.down = false;
    srv.putBlob.mockRejectedValueOnce(new ApiError(413, 'big'));
    await queue.flush();
    expect(store.getState().events).toEqual([]);
    expect(store.getState().pending).toBe(0);
    expect(srv.posted).toEqual([]);
    expect(store.getState().lastError?.message).toContain('a.pdf could not be uploaded');
  });

  test('401 sets queueAccessLost; discard drops the queue and rolls back', async () => {
    const srv = fakeServer();
    srv.postRecord.mockRejectedValue(new ApiError(401, 'no'));
    const { store, queue, actions } = await session(srv.api);
    await actions.putEvent({ name: 'A', type: 'activity' });
    expect(store.getState().queueAccessLost).toBe(true);
    await queue.discard();
    expect(await db.queueList('t1')).toHaveLength(0);
    expect(store.getState().events).toEqual([]);
    expect(store.getState().pending).toBe(0);
    expect(store.getState().queueStalled).toBe(false);
  });

  test('a database blocked by another tab falls back to memory instead of hanging', async () => {
    const name = `blocked-${n++}`;
    // An old-version tab holding v1 open without ever closing it.
    const old = await openDB(name, 1, {
      upgrade(d) {
        d.createObjectStore('trips', { keyPath: 'tripId' });
      },
    });
    const blockedDb = createOfflineDb(name, { openTimeoutMs: 50 });
    const srv = fakeServer();
    const store = createTripStore({
      tripId: 't1',
      fragment,
      cache: blockedDb,
      intervalMs: 1e9,
      api: {
        getTrip: vi.fn().mockResolvedValue(META),
        getRecords: vi.fn().mockResolvedValue({ records: [], latestSeq: 0, more: false }),
      },
    });
    store.start();
    await vi.waitFor(() => expect(store.getState().status).toBe('ready'), { timeout: 3000 });
    const queue = createTripQueue(store, {
      api: srv.api,
      storage: resilientQueueStorage(dbQueueStorage(blockedDb)),
    });
    const actions = createTripActions(store, { queue });
    await actions.putEvent({ name: 'A', type: 'activity' });
    expect(srv.log).toEqual(['record:put']);
    expect(store.getState().pending).toBe(0);
    old.close();
    blockedDb.close();
  });

  test('401 stays queued (a revoked link may be transient)', async () => {
    const srv = fakeServer();
    srv.postRecord.mockRejectedValue(new ApiError(401, 'no'));
    const { store, actions } = await session(srv.api);
    await actions.putEvent({ name: 'A', type: 'activity' });
    expect(await db.queueList('t1')).toHaveLength(1);
    expect(store.getState().pending).toBe(1);
    expect(names(store)).toEqual(['A']);
  });

  test('compaction does not run while the queue is non-empty', async () => {
    const srv = fakeServer();
    srv.state.down = true;
    const { store, actions } = await session(srv.api);
    await actions.putEvent({ name: 'A', type: 'activity' });
    const api = { postRecord: vi.fn(), deleteRecord: vi.fn() };
    expect(await compactTrip(store, api, () => true)).toBe(false);
    expect(api.postRecord).not.toHaveBeenCalled();
  });

  test('two tabs sharing the queue send each item once (Web Lock)', async () => {
    // A minimal navigator.locks: ifAvailable grants the lock to one holder at a time.
    let held = false;
    vi.stubGlobal('navigator', {
      onLine: true,
      locks: {
        request: async (_n: string, _o: unknown, cb: (l: object | null) => Promise<void>) => {
          if (held) return cb(null);
          held = true;
          try {
            await cb({});
          } finally {
            held = false;
          }
        },
      },
    });
    const srv = fakeServer();
    srv.state.down = true;
    const a = await session(srv.api);
    await a.actions.putEvent({ name: 'A', type: 'activity' });
    await a.actions.putEvent({ name: 'B', type: 'activity' });
    const b = await session(srv.api);
    b.queue.start();
    await vi.waitFor(() => expect(names(b.store)).toEqual(['A', 'B']));
    srv.state.down = false;
    await Promise.all([a.queue.flush(), b.queue.flush()]);
    expect(srv.posted).toHaveLength(2);
    expect(await db.queueList('t1')).toHaveLength(0);
    b.queue.stop();
  });
});

describe('idempotency', () => {
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
  const rec = (seq: number, body: RecordBody): OpenedRecord => ({
    seq,
    dedupe: null,
    createdAt: 'x',
    body,
  });

  test('a put or patch posted twice (lost response, then retried) folds like once', () => {
    const p = put('e1', 'A');
    const patch: RecordBody = { kind: 'patch', target: 'e1', fields: { name: 'B' } };
    const once = fold([rec(1, p), rec(2, patch)]);
    // The retry sits right after the original: FIFO means nothing of ours lands in between.
    const dup = fold([rec(1, p), rec(2, p), rec(3, patch), rec(4, patch)]);
    expect(dup).toEqual(once);
  });
});
