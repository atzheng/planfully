// Log compaction (CONTRACTS.md section 3 and 7). Writes each merged record from
// `planCompaction` first, then deletes the records it replaces. Folding gives the same result
// with old and new records both present, so stopping at any point (or two clients compacting
// at once) is safe.

import { planCompaction, sealJson, toBase64 } from '@planfully/shared';
import * as realApi from '../lib/api';
import { ApiError } from '../lib/api';
import type { StoreApi } from 'zustand/vanilla';
import type { TripState } from './store';
import { isTempSeq } from './tempSeq';

export type CompactApi = Pick<typeof realApi, 'postRecord' | 'deleteRecord'>;

/**
 * Compacts the trip's log. Returns false (and does nothing) when it cannot start now: offline,
 * not ready, or writes pending; the caller may try again later. Returns true once it ran, even
 * if a request failed part way (what was written stays valid). Never throws.
 */
export async function compactTrip(
  store: StoreApi<TripState>,
  api: CompactApi = realApi,
  isOnline: () => boolean = () => typeof navigator === 'undefined' || navigator.onLine !== false,
): Promise<boolean> {
  const start = store.getState();
  if (!start.keys || start.status !== 'ready' || start.pending > 0 || !isOnline()) return false;
  // Records that failed to open are invisible to the plan; a snapshot could override them for
  // clients that can read them (e.g. a patch from a newer client). Not retried this session.
  if (start.skipped > 0) return true;
  const { publicKey, accessToken } = start.keys;
  const auth = { tripId: start.tripId, accessToken };

  // Temp (optimistic) records are never planned or deleted.
  const plans = planCompaction(start.records.filter((r) => !isTempSeq(r.seq)));
  try {
    for (const plan of plans) {
      // A user write started: stop, it is not worth racing.
      if (store.getState().pending > 0) return true;
      const sealed = await sealJson(publicKey, plan.write.body);
      const ciphertext = toBase64(sealed);
      const { seq } = await api.postRecord(
        auth,
        plan.write.dedupe === null ? { ciphertext } : { ciphertext, dedupe: plan.write.dedupe },
      );
      store.getState().append([
        {
          seq,
          dedupe: plan.write.dedupe,
          createdAt: new Date().toISOString(),
          body: plan.write.body,
        },
      ]);
      // Only after the append succeeded.
      const gone: number[] = [];
      try {
        for (const s of plan.deleteSeqs) {
          if (isTempSeq(s)) continue;
          // A user write started: leave the rest (old records are harmless).
          if (store.getState().pending > 0) break;
          try {
            await api.deleteRecord(auth, s);
          } catch (e) {
            // Already deleted (another client compacted too): fine.
            if (!(e instanceof ApiError && e.status === 404)) throw e;
          }
          gone.push(s);
        }
      } finally {
        if (gone.length > 0) store.getState().removeRecords(gone);
      }
    }
  } catch {
    // Leave the rest for another session; the log stays valid.
  }
  return true;
}
