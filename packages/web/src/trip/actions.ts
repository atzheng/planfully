// Write path (CONTRACTS.md section 7). Each action builds a RecordBody, shows it immediately as
// a temporary record and hands it to the offline queue (offline/queue.ts), which seals, stores
// and sends it. Success swaps the temp record for the real seq; a server refusal removes it,
// sets `lastError` and rejects; being offline keeps it queued and visible.

import { useMemo } from 'react';
import type { Event, RecordBody } from '@planfully/shared';
import { getTripQueue, type TripQueue } from '../offline/queue';
import { useTripStore, type TripStore } from './store';

export type NewEvent = Pick<Event, 'name' | 'type'> &
  Partial<Omit<Event, 'id' | 'source' | 'createdAt'>>;

export type TripActions = {
  putEvent(event: NewEvent): Promise<Event>;
  patchEvent(id: string, fields: Partial<Omit<Event, 'id'>>): Promise<void>;
  deleteEvent(id: string): Promise<void>;
};

export type ActionOptions = {
  /** The offline queue to write through; defaults to the store's own (offline/queue.ts). */
  queue?: TripQueue;
};

export function createTripActions(store: TripStore, opts: ActionOptions = {}): TripActions {
  // Each write is shown at once, sealed, appended to the persistent queue and sent in order. A
  // network failure leaves it queued (and visible); only a refusal rolls it back and rejects.
  const write = (body: RecordBody): Promise<void> =>
    (opts.queue ?? getTripQueue(store)).enqueueRecord(body);

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
