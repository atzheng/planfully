// Offline edit queue (CONTRACTS.md section 7, planfully-fh8.3).
//
// Every write (a record, or an attachment blob) is sealed, appended to an ordered queue in
// IndexedDB and shown at once as a temporary record; a flush loop then sends the queue head
// first, one item at a time. Nothing is ever stored unsealed, and nothing here logs contents,
// keys or tokens.
//
//  - Network failure (fetch error, 5xx, 408, 429): stop, keep everything queued, retry on
//    `online`, window focus and with backoff. The optimistic record stays visible.
//  - Definitive refusal (other 4xx): drop the item, roll back its temp record, set `lastError`,
//    and drop what depends on it (see `drop`). 401/403/404 are the exception: a revoked link
//    may be a transient proxy or deploy problem, so those stay queued (stalled) rather than
//    destroying the user's edits.
//  - Idempotency: a POST whose response is lost is sent again, so the log may hold the same
//    put/patch twice. Because the queue is strictly FIFO, the duplicate always lands before any
//    later item of ours, so folding gives the same events (tested in queue.test.ts).
//  - Several tabs: the flush loop runs under a Web Lock (`navigator.locks`, one per trip) taken
//    with ifAvailable; a tab that does not get it leaves the work to the holder. The loop re-reads
//    the queue from IndexedDB before every item, so it also sends items another tab or an earlier
//    session enqueued. Where Web Locks are missing, only an in-process mutex applies and two tabs
//    can both send an item (a harmless duplicate, as above). A tab whose temp record was sent by
//    another tab notices (queue item gone) and removes the temp record; the real one arrives
//    with the next sync.

import { openJson, RecordBodySchema, sealJson, toBase64, type RecordBody } from '@planfully/shared';
import * as realApi from '../lib/api';
import { ApiError } from '../lib/api';
import { toError, type TripState } from '../trip/store';
import type { StoreApi } from 'zustand/vanilla';
import { getOfflineDb, safely, type NewQueueItem, type OfflineDb, type QueueItem } from './db';

export type QueueStorage = {
  add(item: NewQueueItem): Promise<number>;
  list(tripId: string): Promise<QueueItem[]>;
  remove(id: number): Promise<void>;
};

/** Fallback where IndexedDB is unavailable: items live for the session only. */
export function memoryQueueStorage(): QueueStorage {
  let next = 1;
  const items = new Map<number, QueueItem>();
  return {
    async add(item) {
      const id = next++;
      items.set(id, { ...item, id });
      return id;
    },
    async list(tripId) {
      return [...items.values()].filter((i) => i.tripId === tripId).sort((a, b) => a.id - b.id);
    },
    async remove(id) {
      items.delete(id);
    },
  };
}

export function dbQueueStorage(db: OfflineDb): QueueStorage {
  return {
    add: (item) => db.queueAdd(item),
    list: (tripId) => db.queueList(tripId),
    remove: (id) => db.queueRemove(id),
  };
}

export type QueueApi = Pick<typeof realApi, 'postRecord' | 'putBlob'>;

export type TripQueueOptions = {
  storage?: QueueStorage;
  api?: QueueApi;
  /** Retry delays in ms after a network failure; the last repeats. */
  backoffMs?: number[];
  /** Clock for the `createdAt` of settled records (tests). */
  now?: () => Date;
};

export type TripQueue = {
  /**
   * Show `body` at once, seal it, queue it and try to send. Resolves after the first attempt
   * that reached it: sent, or left queued (offline). Rejects if the server refused it (the
   * temp record is rolled back and `lastError` set) or the queue could not store it.
   */
  enqueueRecord(body: RecordBody): Promise<void>;
  /** Queue an already sealed blob (before the record that references it). Same resolution rules. */
  enqueueBlob(blobId: string, sealed: Uint8Array): Promise<void>;
  /** Send what can be sent now. Never throws. */
  flush(): Promise<void>;
  /** Open persisted records into the store (once keys exist), then flush; listen for retries. */
  start(): void;
  stop(): void;
};

type Entry = { tempSeq: number; body: RecordBody; sending: boolean };
type Waiter = { resolve(): void; reject(e: unknown): void };

const DEFAULT_BACKOFF = [2000, 5000, 15_000, 30_000, 60_000];

/** Worth retrying later (as opposed to a definitive refusal that dropping fixes). */
export function isRetryable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return true;
  const s = e.status;
  return s >= 500 || s === 408 || s === 429 || s === 401 || s === 403 || s === 404;
}

function attachmentIds(body: RecordBody): string[] {
  const list =
    body.kind === 'put'
      ? body.event.attachments
      : body.kind === 'patch'
        ? body.fields.attachments
        : undefined;
  return (list ?? []).map((a) => a.id);
}

export function createTripQueue(
  store: StoreApi<TripState>,
  opts: TripQueueOptions = {},
): TripQueue {
  const api: QueueApi = opts.api ?? realApi;
  const storage = opts.storage ?? memoryQueueStorage();
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF;
  const tripId = store.getState().tripId;
  const lockName = `planfully-queue-${tripId}`;

  const entries = new Map<number, Entry>(); // by queue item id
  const waiters = new Map<number, Waiter>();
  const failedPuts = new Set<string>(); // event ids whose put was dropped this session
  let addChain: Promise<unknown> = Promise.resolve();
  let flushing: Promise<void> | null = null;
  let rerun = false;
  let started = false;
  let restored = false;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let channel: BroadcastChannel | null = null;
  let unsubscribe: (() => void) | undefined;

  const ws = () => store.getState();

  function settleWaiters(error?: unknown) {
    for (const [id, w] of waiters) {
      waiters.delete(id);
      if (error === undefined) w.resolve();
      else w.reject(error);
    }
  }

  // Roll back a queued record that will never be sent.
  function rollback(id: number, err: unknown, quiet = false) {
    const entry = entries.get(id);
    entries.delete(id);
    if (entry) {
      ws().settleOptimistic(entry.tempSeq);
      ws().setWriteState(
        quiet ? { pendingDelta: -1 } : { pendingDelta: -1, lastError: toError(err) },
      );
    }
    const w = waiters.get(id);
    waiters.delete(id);
    w?.reject(err);
  }

  /**
   * Remove a refused item and everything that cannot work without it: after a dropped put, the
   * later patches/deletes of that event; after a dropped blob, the records whose attachments
   * reference it. Applied transitively.
   */
  async function drop(item: QueueItem, err: unknown) {
    const work: { item: QueueItem; err: unknown; quiet: boolean }[] = [{ item, err, quiet: false }];
    const dependent = new Error('The event this edit belongs to could not be saved.');
    while (work.length > 0) {
      const cur = work.shift() as (typeof work)[number];
      await safely(() => storage.remove(cur.item.id));
      if (cur.item.kind === 'record' && cur.item.op === 'put' && cur.item.eventId) {
        failedPuts.add(cur.item.eventId);
      }
      rollback(cur.item.id, cur.err, cur.quiet);
      const rest = (await safely(() => storage.list(tripId))) ?? [];
      for (const other of rest) {
        const dependsOnPut =
          cur.item.kind === 'record' &&
          cur.item.op === 'put' &&
          other.kind === 'record' &&
          other.eventId === cur.item.eventId &&
          other.id > cur.item.id;
        const dependsOnBlob =
          cur.item.kind === 'blob' &&
          other.kind === 'record' &&
          cur.item.blobId !== undefined &&
          (other.blobIds ?? []).includes(cur.item.blobId);
        if ((dependsOnPut || dependsOnBlob) && !work.some((w) => w.item.id === other.id)) {
          work.push({ item: other, err: dependent, quiet: true });
        }
      }
    }
  }

  // Temp records whose queue item vanished were sent by another tab: drop the temp record (the
  // real one comes with the next sync).
  async function reconcile(list: QueueItem[]) {
    const live = new Set(list.map((i) => i.id));
    let gone = false;
    for (const [id, e] of [...entries]) {
      if (live.has(id) || e.sending) continue;
      entries.delete(id);
      ws().settleOptimistic(e.tempSeq);
      ws().setWriteState({ pendingDelta: -1 });
      waiters.get(id)?.resolve();
      waiters.delete(id);
      gone = true;
    }
    if (gone) void ws().sync();
  }

  async function sendOne(item: QueueItem): Promise<'sent' | 'stalled'> {
    const keys = ws().keys;
    if (!keys) return 'stalled';
    const auth = { tripId, accessToken: keys.accessToken };
    const entry = entries.get(item.id);
    if (entry) entry.sending = true;
    try {
      if (item.kind === 'blob') {
        await api.putBlob(auth, item.blobId as string, item.payload);
      } else {
        const { seq } = await api.postRecord(auth, { ciphertext: toBase64(item.payload) });
        await safely(() => storage.remove(item.id));
        if (entry) {
          entries.delete(item.id);
          ws().settleOptimistic(entry.tempSeq, {
            seq,
            dedupe: null,
            createdAt: (opts.now?.() ?? new Date()).toISOString(),
            body: entry.body,
          });
          ws().setWriteState({ pendingDelta: -1 });
        }
        waiters.get(item.id)?.resolve();
        waiters.delete(item.id);
        return 'sent';
      }
      await safely(() => storage.remove(item.id));
      waiters.get(item.id)?.resolve();
      waiters.delete(item.id);
      return 'sent';
    } catch (e) {
      if (entry) entry.sending = false;
      if (isRetryable(e)) {
        const err = toError(e);
        ws().setWriteState({ queueStalled: true });
        // Show a refused link; plain network trouble is signalled by the indicator alone.
        if (err.kind === 'unauthorized') ws().setWriteState({ lastError: err });
        return 'stalled';
      }
      await drop(item, e);
      return 'sent'; // the loop carries on with the next item
    }
  }

  async function loop() {
    for (;;) {
      const list = await storage.list(tripId);
      await reconcile(list);
      const head = list[0];
      if (!head) {
        attempts = 0;
        ws().setWriteState({ queueStalled: false });
        return;
      }
      const r = await sendOne(head);
      if (r === 'stalled') {
        scheduleRetry();
        return;
      }
      attempts = 0;
      ws().setWriteState({ queueStalled: false });
      if (head.kind === 'record') channel?.postMessage('sent');
    }
  }

  async function underLock(fn: () => Promise<void>) {
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    if (!locks) return fn();
    await locks.request(lockName, { ifAvailable: true }, async (lock) => {
      if (lock) await fn();
    });
  }

  function flush(): Promise<void> {
    if (flushing) {
      rerun = true;
      return flushing;
    }
    const p = (async () => {
      try {
        do {
          rerun = false;
          clearTimeout(retryTimer);
          await underLock(loop);
        } while (rerun);
      } catch {
        // storage failure: leave it for the next trigger
        scheduleRetry();
      } finally {
        flushing = null;
        // Whoever is still waiting has been seen to: sent, refused (rejected above) or left queued.
        settleWaiters();
      }
    })();
    flushing = p;
    return p;
  }

  function scheduleRetry() {
    if (!started) return;
    clearTimeout(retryTimer);
    const delay = backoff[Math.min(attempts, backoff.length - 1)] ?? 60_000;
    attempts++;
    retryTimer = setTimeout(() => void flush(), delay);
  }

  function track(id: number): Promise<void> {
    return new Promise<void>((resolve, reject) => waiters.set(id, { resolve, reject }));
  }

  return {
    enqueueRecord(body) {
      const s = ws();
      const keys = s.keys;
      if (!keys) return Promise.reject(new Error('trip not ready'));
      // Immediate and synchronous: the edit is visible before anything is awaited.
      const tempSeq = s.addOptimistic(body);
      s.setWriteState({ pendingDelta: 1 });
      const eventId = body.kind === 'put' ? body.event.id : body.target;
      const undo = (e: unknown) => {
        ws().settleOptimistic(tempSeq);
        ws().setWriteState({ pendingDelta: -1, lastError: toError(e) });
        throw e;
      };
      // Appends are serialised so queue order is call order whatever the sealing speed.
      const added = addChain.then(async () => {
        const orphaned = () => body.kind !== 'put' && failedPuts.has(eventId);
        const orphan = () => new Error('The event this edit belongs to could not be saved.');
        if (orphaned()) throw orphan();
        const payload = await sealJson(keys.publicKey, body);
        // The put may have been refused while this was being sealed or stored.
        if (orphaned()) throw orphan();
        const id = await storage.add({
          tripId,
          kind: 'record',
          payload,
          op: body.kind,
          eventId,
          blobIds: attachmentIds(body),
          createdAt: new Date().toISOString(),
        });
        if (orphaned()) {
          await safely(() => storage.remove(id));
          throw orphan();
        }
        entries.set(id, { tempSeq, body, sending: false });
        return id;
      });
      addChain = added.catch(() => undefined);
      return added.then((id) => {
        const done = track(id);
        void flush();
        return done;
      }, undo);
    },

    enqueueBlob(blobId, sealed) {
      const added = addChain.then(() =>
        storage.add({
          tripId,
          kind: 'blob',
          payload: sealed,
          blobId,
          createdAt: new Date().toISOString(),
        }),
      );
      addChain = added.catch(() => undefined);
      return added.then((id) => {
        const done = track(id);
        void flush();
        return done;
      });
    },

    flush,

    start() {
      if (started) return;
      started = true;
      const onTrigger = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        attempts = 0;
        void flush();
      };
      window.addEventListener('online', onTrigger);
      window.addEventListener('focus', onTrigger);
      document.addEventListener('visibilitychange', onTrigger);
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(lockName);
        channel.onmessage = () => {
          void storage.list(tripId).then(reconcile);
        };
      }
      unsubscribe = () => {
        window.removeEventListener('online', onTrigger);
        window.removeEventListener('focus', onTrigger);
        document.removeEventListener('visibilitychange', onTrigger);
        channel?.close();
        channel = null;
      };
      void restore();
    },

    stop() {
      started = false;
      clearTimeout(retryTimer);
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };

  // Open queued records left by an earlier session and show them on top of the cached log.
  async function restore() {
    if (restored) return;
    const keys = await waitForKeys();
    if (!keys || !started || restored) return;
    restored = true;
    const list = (await safely(() => storage.list(tripId))) ?? [];
    const known = new Set([...entries.keys()]);
    for (const item of list) {
      if (item.kind !== 'record' || known.has(item.id)) continue;
      let body: RecordBody | null = null;
      try {
        const parsed = RecordBodySchema.safeParse(
          await openJson<unknown>(keys.privateKey, item.payload),
        );
        if (parsed.success) body = parsed.data;
      } catch {
        // sealed to a different key: cannot be shown or sent for this link
      }
      if (!body) continue;
      const tempSeq = ws().addOptimistic(body);
      ws().setWriteState({ pendingDelta: 1 });
      entries.set(item.id, { tempSeq, body, sending: false });
    }
    void flush();
  }

  function waitForKeys(): Promise<NonNullable<TripState['keys']> | null> {
    const now = ws();
    if (now.keys) return Promise.resolve(now.keys);
    if (now.status === 'error') return Promise.resolve(null);
    return new Promise((resolve) => {
      const off = store.subscribe((s) => {
        if (s.keys || s.status === 'error' || !started) {
          off();
          resolve(s.keys);
        }
      });
    });
  }
}

// One queue per store, created on first use. Where IndexedDB is unavailable it is memory-only.
const queues = new WeakMap<object, TripQueue>();

export function getTripQueue(store: StoreApi<TripState>, opts: TripQueueOptions = {}): TripQueue {
  let q = queues.get(store);
  if (!q) {
    const db = getOfflineDb();
    q = createTripQueue(store, { storage: db ? dbQueueStorage(db) : undefined, ...opts });
    queues.set(store, q);
  }
  return q;
}
