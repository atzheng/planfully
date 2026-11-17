import { EventSchema, fromBase64Url, seal, sealJson } from '@planfully/shared';
import type { Attachment, Event } from '@planfully/shared';
import { appendRecord } from '../db/records';
import type { TripRow } from '../db/trips';
import type { Env } from '../env';
import { putBlob } from '../storage/blobs';

/**
 * Seals `bytes` to the trip's public key and stores them under a fresh blob id.
 * `size` in the result is the plaintext size. Throws BlobTooLargeError when the sealed
 * bytes exceed the blob cap. Shared by the default and receipts routes.
 */
export async function storeAttachment(
  env: Env,
  trip: Pick<TripRow, 'id' | 'publicKey'>,
  file: { filename: string; mime: string; bytes: Uint8Array },
): Promise<Attachment> {
  const sealed = await seal(fromBase64Url(trip.publicKey), file.bytes);
  const id = crypto.randomUUID();
  await putBlob(env, trip.id, id, sealed);
  return {
    id,
    filename: file.filename,
    mime: file.mime,
    size: file.bytes.byteLength,
    kind: 'file',
  };
}

/**
 * Validates the event with the shared EventSchema (throws if invalid, so a bad LLM field never
 * becomes a record the web app rejects), seals `{ kind: 'put', event }` and appends it.
 * Returns the record's seq.
 */
export async function appendEvent(
  env: Env,
  trip: Pick<TripRow, 'id' | 'publicKey'>,
  event: Event,
  dedupe: string | null,
): Promise<number> {
  const valid = EventSchema.parse(event);
  const ciphertext = await sealJson(fromBase64Url(trip.publicKey), { kind: 'put', event: valid });
  return appendRecord(env, trip.id, { ciphertext, dedupe });
}
