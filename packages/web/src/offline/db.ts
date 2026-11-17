// Offline cache (CONTRACTS.md section 7, planfully-fh8.2). IndexedDB database 'planfully':
//   trips   { tripId, secret, meta, lastSeq, openedAt }   key tripId
//   records { tripId, seq, ...StoredRecord }              key [tripId, seq]; still sealed
//   blobs   { blobId, tripId, bytes }                     key blobId; sealed bytes, index tripId
//   queue   QueueItem (v2, fh8.3)                         key id (autoIncrement), index tripId; sealed payloads
// The trip secret is stored here in plain form, by design: it is what lets an installed app
// reopen a trip without the link. Nothing here is ever sent anywhere or logged. Temp
// (optimistic) records are never persisted.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { StoredRecord, TripMeta } from '@planfully/shared';
import { isTempSeq } from '../trip/tempSeq';

export type CachedTrip = {
  tripId: string;
  /** Base64url secret from the URL fragment, stored in plain form. */
  secret: string;
  meta: TripMeta;
  /** Server cursor (latestSeq), not the max seq of cached records. */
  lastSeq: number;
  /** ISO instant of the last time the trip was opened. */
  openedAt: string;
  /** ISO instant of the last full load (since=0); older than FULL_RESYNC_MS triggers another. */
  fullLoadAt?: string;
  /** Set when the server refused the link (401/403/404); data is kept. Cleared by the next successful snapshot. */
  revokedAt?: string;
};

/** Cached records are replaced by a full load at least this often (drops stale pre-compaction records). */
export const FULL_RESYNC_MS = 7 * 24 * 60 * 60 * 1000;

/** One unsent write (offline edit queue, offline/queue.ts). `payload` is always sealed. */
export type QueueItem = {
  /** Autoincrement key; ascending id is send order. */
  id: number;
  tripId: string;
  kind: 'record' | 'blob';
  payload: Uint8Array;
  /** kind 'blob': the blob id to PUT. */
  blobId?: string;
  /** kind 'record': the operation and the event it concerns (a random UUID, not content). */
  op?: 'put' | 'patch' | 'delete';
  eventId?: string;
  /** kind 'record': blobs this record's attachments reference (they must upload first). */
  blobIds?: string[];
  createdAt: string;
};
export type NewQueueItem = Omit<QueueItem, 'id'>;

type RecordRow = StoredRecord & { tripId: string };
type BlobRow = { blobId: string; tripId: string; bytes: Uint8Array };

interface PlanfullyDB extends DBSchema {
  trips: { key: string; value: CachedTrip };
  records: { key: [string, number]; value: RecordRow };
  blobs: { key: string; value: BlobRow; indexes: { tripId: string } };
  queue: { key: number; value: QueueItem; indexes: { tripId: string } };
}

export type Snapshot = {
  tripId: string;
  /** Needed when the trip is not cached yet, or to replace a different cached secret. */
  secret?: string;
  meta: TripMeta;
  lastSeq: number;
  /** Sealed records to add (temp seqs are dropped). */
  records: StoredRecord[];
  /** Drop every cached record of this trip first (a full load from since=0). */
  replace?: boolean;
  openedAt?: string;
};

export type OfflineDb = {
  getTrip(tripId: string): Promise<CachedTrip | undefined>;
  /** Most recently opened first. */
  listTrips(): Promise<CachedTrip[]>;
  loadRecords(tripId: string): Promise<StoredRecord[]>;
  /** One transaction: records, then the trip row. Skipped without a secret for an unknown trip. */
  saveSnapshot(s: Snapshot): Promise<void>;
  removeRecords(tripId: string, seqs: number[]): Promise<void>;
  touch(tripId: string, openedAt?: string): Promise<void>;
  /** Non-destructive: flag the cached trip as refused by the server. */
  markRevoked(tripId: string): Promise<void>;
  getBlob(blobId: string): Promise<Uint8Array | undefined>;
  hasBlob(blobId: string): Promise<boolean>;
  putBlob(tripId: string, blobId: string, bytes: Uint8Array): Promise<void>;
  /** Add sealed records without touching lastSeq; ignored for a trip that is not cached. */
  putRecords(tripId: string, records: StoredRecord[]): Promise<void>;
  /**
   * Remove a trip's secret, records, blobs and queued writes. Other trips are untouched. Any
   * new store must be cleared here too.
   */
  forgetTrip(tripId: string): Promise<void>;
  /** Offline edit queue: append, list in send order, remove one. */
  queueAdd(item: NewQueueItem): Promise<number>;
  queueList(tripId: string): Promise<QueueItem[]>;
  queueRemove(id: number): Promise<void>;
  close(): void;
};

const DB_NAME = 'planfully';

/** How long a caller waits for the database to open (a blocked upgrade never does). */
export const OPEN_TIMEOUT_MS = 3000;

export function createOfflineDb(
  name = DB_NAME,
  { openTimeoutMs = OPEN_TIMEOUT_MS }: { openTimeoutMs?: number } = {},
): OfflineDb {
  // The connection. Another tab holding an older version open blocks our upgrade (the open
  // never settles), so callers wait at most OPEN_TIMEOUT_MS and then fail fast (the cache is
  // optional: safely() swallows it and the queue falls back to memory). If the open completes
  // later, later calls use it. We close our own handle when another tab wants to upgrade.
  let handle: IDBPDatabase<PlanfullyDB> | null = null;
  let opening: Promise<IDBPDatabase<PlanfullyDB>> | null = null;
  let gaveUp = false;
  const reset = () => {
    handle = null;
    opening = null;
  };
  const db = async (): Promise<IDBPDatabase<PlanfullyDB>> => {
    if (handle) return handle;
    opening ??= openDB<PlanfullyDB>(name, 2, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          d.createObjectStore('trips', { keyPath: 'tripId' });
          d.createObjectStore('records', { keyPath: ['tripId', 'seq'] });
          d.createObjectStore('blobs', { keyPath: 'blobId' }).createIndex('tripId', 'tripId');
        }
        if (oldVersion < 2) {
          d.createObjectStore('queue', { keyPath: 'id', autoIncrement: true }).createIndex(
            'tripId',
            'tripId',
          );
        }
      },
      blocking() {
        handle?.close();
        reset();
      },
      terminated: reset,
    }).then(
      (h) => {
        handle = h;
        gaveUp = false;
        return h;
      },
      (e: unknown) => {
        opening = null;
        throw e;
      },
    );
    if (gaveUp) throw new Error('offline cache unavailable');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        gaveUp = true;
        reject(new Error('offline cache open timed out'));
      }, openTimeoutMs);
    });
    try {
      return await Promise.race([opening, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  const range = (tripId: string) => IDBKeyRange.bound([tripId, -Infinity], [tripId, Infinity]);

  return {
    async getTrip(tripId) {
      return (await db()).get('trips', tripId);
    },
    async listTrips() {
      const all = await (await db()).getAll('trips');
      return all.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
    },
    async loadRecords(tripId) {
      const rows = await (await db()).getAll('records', range(tripId));
      return rows
        .filter((r) => !isTempSeq(r.seq))
        .sort((a, b) => a.seq - b.seq)
        .map(({ seq, dedupe, ciphertext, createdAt }) => ({ seq, dedupe, ciphertext, createdAt }));
    },
    async saveSnapshot(s) {
      const tx = (await db()).transaction(['trips', 'records'], 'readwrite');
      const existing = await tx.objectStore('trips').get(s.tripId);
      const secret = s.secret ?? existing?.secret;
      if (secret === undefined) {
        await tx.done;
        return;
      }
      const rec = tx.objectStore('records');
      if (s.replace || (existing && existing.secret !== secret)) await rec.delete(range(s.tripId));
      for (const r of s.records) {
        if (isTempSeq(r.seq)) continue;
        await rec.put({
          tripId: s.tripId,
          seq: r.seq,
          dedupe: r.dedupe,
          ciphertext: r.ciphertext,
          createdAt: r.createdAt,
        });
      }
      await tx.objectStore('trips').put({
        tripId: s.tripId,
        secret,
        meta: s.meta,
        lastSeq: s.lastSeq,
        openedAt: s.openedAt ?? new Date().toISOString(),
        fullLoadAt: s.replace ? new Date().toISOString() : existing?.fullLoadAt,
      });
      await tx.done;
    },
    async removeRecords(tripId, seqs) {
      const tx = (await db()).transaction('records', 'readwrite');
      for (const seq of seqs) if (!isTempSeq(seq)) await tx.store.delete([tripId, seq]);
      await tx.done;
    },
    async touch(tripId, openedAt) {
      const tx = (await db()).transaction('trips', 'readwrite');
      const t = await tx.store.get(tripId);
      if (t) await tx.store.put({ ...t, openedAt: openedAt ?? new Date().toISOString() });
      await tx.done;
    },
    async markRevoked(tripId) {
      const tx = (await db()).transaction('trips', 'readwrite');
      const t = await tx.store.get(tripId);
      if (t && !t.revokedAt) await tx.store.put({ ...t, revokedAt: new Date().toISOString() });
      await tx.done;
    },
    async getBlob(blobId) {
      return (await (await db()).get('blobs', blobId))?.bytes;
    },
    async hasBlob(blobId) {
      return (await (await db()).getKey('blobs', blobId)) !== undefined;
    },
    async putBlob(tripId, blobId, bytes) {
      // Same transaction as the check: a blob must not outlive a forgotten trip.
      const tx = (await db()).transaction(['trips', 'blobs'], 'readwrite');
      if (await tx.objectStore('trips').getKey(tripId)) {
        await tx.objectStore('blobs').put({ blobId, tripId, bytes });
      }
      await tx.done;
    },
    async putRecords(tripId, records) {
      const tx = (await db()).transaction(['trips', 'records'], 'readwrite');
      if (await tx.objectStore('trips').getKey(tripId)) {
        for (const r of records) {
          if (isTempSeq(r.seq)) continue;
          await tx.objectStore('records').put({ tripId, ...r });
        }
      }
      await tx.done;
    },
    async queueAdd(item) {
      // `id` is assigned by the store.
      return (await db()).add('queue', item as QueueItem);
    },
    async queueList(tripId) {
      const rows = await (await db()).getAllFromIndex('queue', 'tripId', tripId);
      return rows.sort((a, b) => a.id - b.id);
    },
    async queueRemove(id) {
      await (await db()).delete('queue', id);
    },
    async forgetTrip(tripId) {
      const tx = (await db()).transaction(['trips', 'records', 'blobs', 'queue'], 'readwrite');
      const q = tx.objectStore('queue');
      for (const key of await q.index('tripId').getAllKeys(tripId)) await q.delete(key);
      await tx.objectStore('trips').delete(tripId);
      await tx.objectStore('records').delete(range(tripId));
      const blobs = tx.objectStore('blobs');
      for (const key of await blobs.index('tripId').getAllKeys(tripId)) await blobs.delete(key);
      await tx.done;
    },
    close() {
      void opening?.then(
        (d) => d.close(),
        () => undefined,
      );
      handle?.close();
      reset();
    },
  };
}

let shared: OfflineDb | null | undefined;

/** The app-wide cache, or null where IndexedDB is unavailable (callers must treat it as optional). */
export function getOfflineDb(): OfflineDb | null {
  if (shared === undefined) shared = typeof indexedDB === 'undefined' ? null : createOfflineDb();
  return shared;
}

/** Test hook: replace (or clear with null) the app-wide cache. */
export function setOfflineDb(db: OfflineDb | null | undefined): void {
  shared = db;
}

/** Cache failures (private mode, quota) must never break the app. */
export async function safely<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}
