// Write path (CONTRACTS.md section 7). Each action builds a RecordBody, shows it immediately as
// a temporary record, seals it to the trip public key and sends it. Success swaps the temp record
// for the real seq; failure removes it, sets `lastError` and rethrows.

import { useMemo } from 'react';
import { sealJson, toBase64, type Event, type RecordBody } from '@planfully/shared';
import * as realApi from '../lib/api';
import { toError, useTripStore, type TripStore } from './store';

/** The single network step; an offline queue can wrap or replace it. */
export type SendRecord = (sealed: Uint8Array) => Promise<{ seq: number }>;

export type NewEvent = Pick<Event, 'name' | 'type'> &
  Partial<Omit<Event, 'id' | 'source' | 'createdAt'>>;

export type TripActions = {
  putEvent(event: NewEvent): Promise<Event>;
  patchEvent(id: string, fields: Partial<Omit<Event, 'id'>>): Promise<void>;
  deleteEvent(id: string): Promise<void>;
};

export type ActionOptions = {
  api?: Pick<typeof realApi, 'postRecord'>;
  sendRecord?: SendRecord;
};

export function createTripActions(store: TripStore, opts: ActionOptions = {}): TripActions {
  const api = opts.api ?? realApi;

  const defaultSend: SendRecord = async (sealed) => {
    const { tripId, keys } = store.getState();
    if (!keys) throw new Error('trip not ready');
    // No dedupe tag from the browser.
    return api.postRecord(
      { tripId, accessToken: keys.accessToken },
      { ciphertext: toBase64(sealed) },
    );
  };
  const sendRecord = opts.sendRecord ?? defaultSend;

  // Sends go out one at a time, in call order, so a patch can never get a lower seq than the
  // put it targets. The optimistic apply still happens immediately.
  let chain: Promise<unknown> = Promise.resolve();
  // Ids of puts that failed; queued patches/deletes targeting them are dropped, not sent.
  const failedPuts = new Set<string>();

  async function write(body: RecordBody): Promise<void> {
    const s = store.getState();
    if (!s.keys) throw new Error('trip not ready');
    const publicKey = s.keys.publicKey;
    const tempSeq = s.addOptimistic(body);
    s.setWriteState({ pendingDelta: 1 });
    const target = body.kind === 'put' ? null : body.target;
    const run = async () => {
      if (target !== null && failedPuts.has(target)) {
        throw new Error('The event this edit belongs to could not be saved.');
      }
      const sealed = await sealJson(publicKey, body);
      return sendRecord(sealed);
    };
    const result = chain.then(run, run);
    chain = result.catch(() => undefined);
    try {
      const { seq } = await result;
      const now = store.getState();
      now.settleOptimistic(tempSeq, {
        seq,
        dedupe: null,
        createdAt: new Date().toISOString(),
        body,
      });
      now.setWriteState({ pendingDelta: -1 });
    } catch (e) {
      if (body.kind === 'put') failedPuts.add(body.event.id);
      const now = store.getState();
      now.settleOptimistic(tempSeq);
      now.setWriteState({ pendingDelta: -1, lastError: toError(e) });
      throw e;
    }
  }

  return {
    async putEvent(input) {
      // Explicit undefined values must not override the defaults.
      const given = Object.fromEntries(
        Object.entries(input).filter(([, v]) => v !== undefined),
      ) as NewEvent;
      const event: Event = {
        attachments: [],
        participants: [],
        status: 'confirmed',
        ...given,
        id: crypto.randomUUID(),
        source: 'manual',
        createdAt: new Date().toISOString(),
      };
      await write({ kind: 'put', event });
      return event;
    },
    patchEvent: (id, fields) => write({ kind: 'patch', target: id, fields }),
    deleteEvent: (id) => write({ kind: 'delete', target: id }),
  };
}

/** Actions bound to the current trip store. */
export function useTripActions(): TripActions {
  const store = useTripStore();
  return useMemo(() => createTripActions(store), [store]);
}
