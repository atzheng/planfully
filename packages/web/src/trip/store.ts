// Trip store (CONTRACTS.md section 7). Reads the secret once, derives keys in memory, loads and
// opens every record, folds to events, and keeps them current by polling with since=<cursor>.
// The raw secret is not retained after key derivation and is never sent anywhere; only the
// access token goes out, via lib/api.ts's Authorization header.

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
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
import { compactTrip } from './compact';
import { isTempSeq, TEMP_SEQ_BASE } from './tempSeq';

export type TripKeys = { privateKey: Uint8Array; publicKey: Uint8Array; accessToken: string };

export type TripErrorKind = 'bad-link' | 'unauthorized' | 'undecryptable' | 'network' | 'unknown';
export type TripError = { kind: TripErrorKind; message: string };

export const MESSAGES = {
  badLink: 'This link is missing its key',
  unauthorized: 'Trip not found or wrong key',
  undecryptable: "This link's key doesn't open this trip's data.",
  stalled: 'The server sent an incomplete response.',
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
  /** Compaction hook: drop records the server no longer holds. */
  removeRecords(seqs: number[]): void;
  /** Replace the stored meta (after a PATCH). */
  setMeta(meta: TripMeta): void;
  /** Writes in flight (trip/actions.ts). */
  pending: number;
  /** The last failed write. Only cleared by the UI via setWriteState({ lastError: null }). */
  lastError: TripError | null;
  /** Write path: show a temporary record immediately; returns its (very large) temp seq. */
  addOptimistic(body: OpenedRecord['body']): number;
  /** Write path: drop the temp record, adding the real one if given (rollback if omitted). */
  settleOptimistic(tempSeq: number, real?: OpenedRecord): void;
  /** Write path: adjust `pending` and set/clear `lastError`. */
  setWriteState(patch: { pendingDelta?: number; lastError?: TripError | null }): void;
};

export type TripApi = Pick<typeof realApi, 'getTrip' | 'getRecords'> &
  Partial<Pick<typeof realApi, 'postRecord' | 'deleteRecord'>>;

export type TripStoreOptions = {
  tripId: string;
  /** The URL fragment, with or without the leading '#'. */
  fragment: string;
  api?: TripApi;
  /** Polling interval in ms while the page is visible. */
  intervalMs?: number;
  /** Called when the URL fragment changes to a different secret; the owner should replace the store. */
  onReplace?: (fragment: string) => void;
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

class StalledError extends Error {}

export { isTempSeq };

export function toError(e: unknown): TripError {
  if (e instanceof StalledError) return { kind: 'unknown', message: MESSAGES.stalled };
  if (e instanceof realApi.ApiError) {
    if (e.status === 401 || e.status === 403 || e.status === 404) {
      return { kind: 'unauthorized', message: MESSAGES.unauthorized };
    }
    if (e.status === 429 || e.status >= 500) return { kind: 'network', message: MESSAGES.network };
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
  let tempCounter = 0;
  let started = false;
  // Compaction runs at most once per store (session) once it has actually been able to start.
  let compactStarted = false;
  function maybeCompact() {
    const { postRecord, deleteRecord } = api;
    if (compactStarted || !started || !postRecord || !deleteRecord) return;
    compactStarted = true;
    void compactTrip(store, { postRecord, deleteRecord }).then((ran) => {
      if (!ran) compactStarted = false;
    });
  }
  // The raw fragment is only held until keys are derived.
  let fragment: string | null = opts.fragment;

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
        const next = Math.max(cursor, page.latestSeq);
        if (!page.more) {
          cursor = next;
          break;
        }
        // More pages promised but no progress: bail out instead of hammering the server.
        if (page.records.length === 0 && next <= cursor) throw new StalledError();
        cursor = next;
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
        if (skipped > 0 && opened.length === 0) {
          set({
            status: 'error',
            error: { kind: 'undecryptable', message: MESSAGES.undecryptable },
            skipped,
          });
          return;
        }
        // Records appended (e.g. by the write path) while loading must survive the replacement.
        const records = mergeRecords(opened, get().records);
        set({
          meta,
          records,
          events: fold(records),
          skipped,
          cursor,
          status: 'ready',
          error: null,
        });
        maybeCompact();
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
        const patch: Partial<TripState> = {};
        if (next > s.cursor) patch.cursor = next;
        if (skipped > 0) patch.skipped = s.skipped + skipped;
        if (s.error) patch.error = null;
        if (records !== s.records) {
          patch.records = records;
          patch.events = fold(records);
        }
        if (Object.keys(patch).length > 0) set(patch);
        maybeCompact();
      } catch (e) {
        const err = toError(e);
        // Keep showing the last data; a revoked link is fatal.
        const cur = get().error;
        if (err.kind === 'unauthorized') set({ status: 'error', error: err });
        else if (cur?.kind !== err.kind || cur.message !== err.message) set({ error: err });
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
      removeRecords: (seqs) => {
        const gone = new Set(seqs);
        const records = get().records.filter((r) => !gone.has(r.seq));
        if (records.length === get().records.length) return;
        set({ records, events: fold(records) });
      },
      setMeta: (meta) => set({ meta }),
      pending: 0,
      lastError: null,
      addOptimistic: (body) => {
        const s = get();
        // Temp seqs sit above any real seq so they fold last, in submission order.
        tempCounter++;
        const seq = TEMP_SEQ_BASE + tempCounter;
        const records = [
          ...s.records,
          { seq, dedupe: null, createdAt: new Date().toISOString(), body },
        ];
        set({ records, events: fold(records) });
        return seq;
      },
      settleOptimistic: (tempSeq, real) => {
        let records = get().records.filter((r) => r.seq !== tempSeq);
        if (real) records = mergeRecords(records, [real]);
        set({ records, events: fold(records) });
      },
      setWriteState: ({ pendingDelta, lastError }) => {
        const patch: Partial<TripState> = {};
        if (pendingDelta) patch.pending = Math.max(0, get().pending + pendingDelta);
        if (lastError !== undefined) patch.lastError = lastError;
        set(patch);
      },
    };
  });

  // Memoised: start() may run more than once (StrictMode) and both runs share one derivation.
  let initPromise: Promise<void> | null = null;
  function init(): Promise<void> {
    initPromise ??= (async () => {
      const frag = (fragment ?? '').replace(/^#/, '');
      try {
        const keys = await deriveTripKeys(decodeSecret(frag));
        auth = { tripId: opts.tripId, accessToken: keys.accessToken };
        store.setState({ keys });
      } catch {
        store.setState({
          status: 'error',
          error: { kind: 'bad-link', message: MESSAGES.badLink },
        });
      } finally {
        fragment = null; // the raw secret is not kept once keys are derived
      }
    })();
    return initPromise;
  }

  const onFocus = () => {
    if (document.visibilityState !== 'hidden') void store.getState().sync();
  };

  const onHashChange = () => {
    const frag = window.location.hash.replace(/^#/, '');
    // A removed fragment (in-app navigation) keeps the current keys.
    if (frag === '' || !opts.onReplace) return;
    const replace = opts.onReplace;
    void (async () => {
      try {
        const keys = await deriveTripKeys(decodeSecret(frag));
        if (keys.accessToken === store.getState().keys?.accessToken) return;
      } catch {
        // an invalid new fragment replaces the store too, which shows the bad-link error
      }
      replace(frag);
    })();
  };

  return Object.assign(store, {
    start() {
      if (started) return;
      started = true;
      void init().then(() => {
        if (started && store.getState().keys) void store.getState().sync();
      });
      window.addEventListener('focus', onFocus);
      window.addEventListener('hashchange', onHashChange);
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
      window.removeEventListener('hashchange', onHashChange);
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
  // Read the fragment once per trip; the store never exposes it. A different secret in the
  // fragment (hashchange) replaces the store.
  const ref = useRef<{ id: string; store: TripStore } | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const make = (fragment: string): TripStore =>
    createTripStore({
      tripId,
      fragment,
      onReplace: (f) => {
        ref.current = { id: tripId, store: make(f) };
        bump();
      },
    });
  if (!ref.current || ref.current.id !== tripId) {
    ref.current = { id: tripId, store: store ?? make(window.location.hash) };
  }
  const current = ref.current.store;
  useEffect(() => {
    current.start();
    return () => current.stop();
  }, [current]);
  return createElement(TripContext.Provider, { value: current }, children);
}

export function useTripStore(): TripStore {
  const store = useContext(TripContext);
  if (!store) throw new Error('useTripStore must be used inside <TripProvider>');
  return store;
}

export function useTrip(): TripState;
export function useTrip<T>(selector: (s: TripState) => T): T;
export function useTrip<T>(selector?: (s: TripState) => T): T | TripState {
  const store = useContext(TripContext);
  if (!store) throw new Error('useTrip must be used inside <TripProvider>');
  return useStore(store, selector ?? ((s) => s as unknown as T));
}
