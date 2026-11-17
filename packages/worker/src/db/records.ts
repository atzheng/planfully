import { toBase64, type StoredRecord } from '@planfully/shared';
import type { Env } from '../env';

/** Page size cap used by the HTTP route. */
export const MAX_PAGE = 500;

/**
 * Stores a sealed record and returns its seq (first record of a trip is 1).
 *
 * One D1 batch (a single transaction, and D1 serialises writes per database): bump the trip's
 * counter, then insert using the bumped value. D1 cannot pass RETURNING output between batch
 * statements, so the insert reads `next_seq` back with a subselect; inside the transaction that
 * is the value just assigned. The counter only ever grows, so seqs are never reused after deletes.
 * Throws if the trip does not exist.
 */
export async function appendRecord(
  env: Env,
  tripId: string,
  r: { ciphertext: Uint8Array; dedupe?: string | null },
): Promise<number> {
  const [, ins] = await env.DB.batch([
    env.DB.prepare('UPDATE trips SET next_seq = next_seq + 1 WHERE id = ?').bind(tripId),
    env.DB.prepare(
      `INSERT INTO records (trip_id, seq, dedupe, ciphertext, created_at)
       SELECT id, next_seq, ?, ?, ? FROM trips WHERE id = ?
       RETURNING seq`,
    ).bind(r.dedupe ?? null, r.ciphertext, new Date().toISOString(), tripId),
  ]);
  const seq = (ins?.results[0] as { seq: number } | undefined)?.seq;
  if (seq === undefined) throw new Error('trip not found');
  return seq;
}

interface RawRecord {
  seq: number;
  dedupe: string | null;
  ciphertext: ArrayBuffer | number[];
  created_at: string;
}

/** Records with seq > since, ascending. Optional `limit` caps the page. */
export async function listRecords(
  env: Env,
  tripId: string,
  since: number,
  limit = -1,
): Promise<StoredRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT seq, dedupe, ciphertext, created_at FROM records
     WHERE trip_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
  )
    .bind(tripId, since, limit)
    .all<RawRecord>();
  return results.map((r) => ({
    seq: r.seq,
    dedupe: r.dedupe,
    ciphertext: toBase64(new Uint8Array(r.ciphertext)),
    createdAt: r.created_at,
  }));
}

/** Idempotent: deleting a missing record is a no-op. */
export async function deleteRecord(env: Env, tripId: string, seq: number): Promise<void> {
  await env.DB.prepare('DELETE FROM records WHERE trip_id = ? AND seq = ?').bind(tripId, seq).run();
}
