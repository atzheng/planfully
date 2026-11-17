// Trip store (CONTRACTS.md section 7). Reads the secret once, derives keys in memory, loads and
// opens every record, folds to events, and keeps them current by polling with since=<cursor>.
// The raw secret is not retained after key derivation and is never sent anywhere; only the
// access token goes out, via lib/api.ts's Authorization header.

import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  decodeSecret,
  deriveTripKeys,
  fold,
  fromBase64,
  openJson,
  RecordBodySchema,
  type Event,
  type OpenedRecord,
  type StoredRecord,
  type TripMeta,
} from '@planfully/shared';
import * as realApi from '../lib/api';

export type TripKeys = { privateKey: Uint8Array; publicKey: Uint8Array; accessToken: string };

export type TripErrorKind = 'bad-link' | 'unauthorized' | 'network' | 'unknown';
export type TripError = { kind: TripErrorKind; message: string };

export const MESSAGES = {
  badLink: 'This link is missing its key',
  unauthorized: 'Trip not found or wrong key',
  network: 'Could not reach the server. Retrying...',
} as const;

export type TripState = {
  tripId: string;
  meta: TripMeta | null;
  /** fold() output; recomputed once per change to `records`. */
  events: Event[];
  /** Opened records, ascending by seq. */
  records: OpenedRecord[];
  /** Records that failed to decrypt or validate, cumulative. */
  skipped: number;
  /** Server cursor: pass as `since` on the next fetch. */
  cursor: number;
  keys: TripKeys | null;
  status: 'loading' | 'ready' | 'error';
  /** Fatal (status 'error') or, while ready, the last failed sync (kind 'network'). */
  error: TripError | null;
  /** Fetch records newer than the cursor and re-fold. Safe to call concurrently. */
  sync(): Promise<void>;
  /** Write path hook: merge records the client has just written (already opened). */
  append(records: OpenedRecord[]): void;
  /** Replace the stored meta (after a PATCH). */
  setMeta(meta: TripMeta): void;
};

export type TripApi = Pick<typeof realApi, 'getTrip' | 'getRecords'>;

export type TripStoreOptions = {
  tripId: string;
  /** The URL fragment, with or without the leading '#'. */
  fragment: string;
  api?: TripApi;
  /** Polling interval in ms while the page is visible. */
  intervalMs?: number;
  /** Initial-load retry delays in ms; the last repeats. */
  backoffMs?: number[];
};

export type TripStore = StoreApi<TripState> & { start(): void; stop(): void };

type Auth = { tripId: string; accessToken: string };

const MAX_PAGES = 1000;

/** Open and validate stored records; returns the good ones and the number skipped. */
export async function openRecords(
  privateKey: Uint8Array,
  stored: StoredRecord[],
): Promise<{ opened: OpenedRecord[]; skipped: number }> {
  const opened: OpenedRecord[] = [];
  let skipped = 0;
  for (const r of stored) {
    try {
      const raw = await openJson<unknown>(privateKey, fromBase64(r.ciphertext));
      const parsed = RecordBodySchema.safeParse(raw);
      if (!parsed.success) {
        skipped++;
        continue;
      }
      opened.push({ seq: r.seq, dedupe: r.dedupe, createdAt: r.createdAt, body: parsed.data });
    } catch {
      skipped++;
    }
  }
  return { opened, skipped };
}

function mergeRecords(have: OpenedRecord[], add: OpenedRecord[]): OpenedRecord[] {
  if (add.length === 0) return have;
  const seen = new Set(have.map((r) => r.seq));
  const fresh = add.filter((r) => !seen.has(r.seq));
  if (fresh.length === 0) return have;
  return [...have, ...fresh].sort((a, b) => a.seq - b.seq);
}

function toError(e: unknown): TripError {
  if (e instanceof realApi.ApiError) {
    if (e.status === 401 || e.status === 403 || e.status === 404) {
      return { kind: 'unauthorized', message: MESSAGES.unauthorized };
    }
    if (e.status >= 500) return { kind: 'network', message: MESSAGES.network };
    return { kind: 'unknown', message: e.message };
  }
  return { kind: 'network', message: MESSAGES.network };
}

export function createTripStore(opts: TripStoreOptions): TripStore {
  const api = opts.api ?? realApi;
  const intervalMs = opts.intervalMs ?? 60_000;
  const backoff = opts.backoffMs ?? [2000, 5000, 15_000, 30_000];
  let auth: Auth | null = null;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let started = false;

  const store = createStore<TripState>((set, get) => {
    // Pages through records since `since`, opening as it goes.
    async function fetchAll(keys: TripKeys, a: Auth, since: number) {
      let cursor = since;
      const opened: OpenedRecord[] = [];
      let skipped = 0;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await api.getRecords(a, cursor);
        const r = await openRecords(keys.privateKey, page.records);
        opened.push(...r.opened);
        skipped += r.skipped;
        cursor = Math.max(cursor, page.latestSeq);
        if (!page.more) break;
      }
      return { opened, skipped, cursor };
    }

    async function load() {
      const { keys } = get();
      if (!keys || !auth) return;
      try {
        const meta = await api.getTrip(auth);
        const { opened, skipped, cursor } = await fetchAll(keys, auth, 0);
        attempts = 0;
        set({
          meta,
          records: opened,
          events: fold(opened),
          skipped,
          cursor,
          status: 'ready',
          error: null,
        });
      } catch (e) {
        const err = toError(e);
        set({ status: 'error', error: err });
        if (err.kind === 'network' && started) {
          const delay = backoff[Math.min(attempts, backoff.length - 1)] ?? 30_000;
          attempts++;
          retryTimer = setTimeout(() => {
            if (started) void get().sync();
          }, delay);
        }
      }
    }

    async function syncOnce() {
      const { keys, cursor } = get();
      if (!keys || !auth) return;
      try {
        const { opened, skipped, cursor: next } = await fetchAll(keys, auth, cursor);
        const s = get();
        const records = mergeRecords(s.records, opened);
        set({
          cursor: Math.max(s.cursor, next),
          skipped: s.skipped + skipped,
          error: null,
          ...(records !== s.records ? { records, events: fold(records) } : {}),
        });
      } catch (e) {
        const err = toError(e);
        // Keep showing the last data; a revoked link is fatal.
        set(err.kind === 'unauthorized' ? { status: 'error', error: err } : { error: err });
      }
    }

    function run(): Promise<void> {
      if (inflight) return inflight;
      const s = get();
      if (!s.keys) return Promise.resolve();
      const p = (s.status === 'ready' ? syncOnce() : load()).finally(() => {
        inflight = null;
      });
      inflight = p;
      return p;
    }

    return {
      tripId: opts.tripId,
      meta: null,
      events: [],
      records: [],
      skipped: 0,
      cursor: 0,
      keys: null,
      status: 'loading',
      error: null,
      sync: () => {
        const s = get();
        if (s.status === 'error') {
          // Only a network failure is worth retrying; bad link / revoked stay put.
          if (s.error?.kind !== 'network' || s.meta !== null) return Promise.resolve();
          clearTimeout(retryTimer);
        }
        return run();
      },
      append: (add) => {
        const s = get();
        const records = mergeRecords(s.records, add);
        if (records === s.records) return;
        // The cursor is not advanced: the server may hold records between ours and the new
        // seq, and the next sync must fetch them (merge dedupes by seq).
        set({ records, events: fold(records) });
      },
      setMeta: (meta) => set({ meta }),
    };
  });

  async function init() {
    const frag = opts.fragment.replace(/^#/, '');
    try {
      const secret = decodeSecret(frag);
      const keys = await deriveTripKeys(secret);
      auth = { tripId: opts.tripId, accessToken: keys.accessToken };
      store.setState({ keys });
    } catch {
      store.setState({ status: 'error', error: { kind: 'bad-link', message: MESSAGES.badLink } });
    }
  }

  const onFocus = () => {
    if (document.visibilityState !== 'hidden') void store.getState().sync();
  };

  return Object.assign(store, {
    start() {
      if (started) return;
      started = true;
      void init().then(() => {
        if (started && store.getState().keys) void store.getState().sync();
      });
      window.addEventListener('focus', onFocus);
      document.addEventListener('visibilitychange', onFocus);
      timer = setInterval(() => {
        if (document.visibilityState !== 'hidden' && store.getState().status === 'ready') {
          void store.getState().sync();
        }
      }, intervalMs);
    },
    stop() {
      started = false;
      clearInterval(timer);
      clearTimeout(retryTimer);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    },
  });
}

const TripContext = createContext<TripStore | null>(null);

export function TripProvider({
  tripId,
  children,
  store,
}: {
  tripId: string;
  children: ReactNode;
  /** Tests may inject a store. */
  store?: TripStore;
}) {
  // Read the fragment once per trip; the store never exposes it.
  const ref = useRef<{ id: string; store: TripStore } | null>(null);
  if (!ref.current || ref.current.id !== tripId) {
    ref.current = {
      id: tripId,
      store: store ?? createTripStore({ tripId, fragment: window.location.hash }),
    };
  }
  const current = ref.current.store;
  useEffect(() => {
    current.start();
    return () => current.stop();
  }, [current]);
  return createElement(TripContext.Provider, { value: current }, children);
}

export function useTrip(): TripState;
export function useTrip<T>(selector: (s: TripState) => T): T;
export function useTrip<T>(selector?: (s: TripState) => T): T | TripState {
  const store = useContext(TripContext);
  if (!store) throw new Error('useTrip must be used inside <TripProvider>');
  return useStore(store, selector ?? ((s) => s as unknown as T));
}
