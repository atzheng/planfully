import type { Env } from '../env';

/** Blob size cap (CONTRACTS.md section 5). */
export const MAX_BLOB_BYTES = 25 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isBlobId(id: string): boolean {
  return UUID.test(id);
}

export function blobKey(tripId: string, blobId: string): string {
  return `trips/${tripId}/blobs/${blobId}`;
}

/** Thrown when a blob with this id is already stored (blobs are immutable). */
export class BlobExistsError extends Error {
  constructor() {
    super('blob exists');
    this.name = 'BlobExistsError';
  }
}

/** Thrown when the body is larger than MAX_BLOB_BYTES or does not match its declared length. */
export class BlobTooLargeError extends Error {
  constructor() {
    super('blob too large');
    this.name = 'BlobTooLargeError';
  }
}

// Atomic create-only: R2 refuses the put (returns null) when any object exists at the key.
const CREATE_ONLY = { etagDoesNotMatch: '*' } as const;

/** Stores bytes under the trip's key. Throws BlobExistsError if the id is taken. */
export async function putBlob(
  env: Env,
  tripId: string,
  blobId: string,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.byteLength > MAX_BLOB_BYTES) throw new BlobTooLargeError();
  const res = await env.BLOBS.put(blobKey(tripId, blobId), bytes, { onlyIf: CREATE_ONLY });
  if (res === null) throw new BlobExistsError();
}

/**
 * Streams a body of exactly `length` bytes to R2. R2 needs a known length for
 * streams, so FixedLengthStream carries it; it also errors if the source sends
 * more or fewer bytes than declared, so a lying Content-Length cannot get past
 * the cap. Throws BlobTooLargeError (cap exceeded or length mismatch) or
 * BlobExistsError. Nothing is stored on failure.
 */
export async function putBlobStream(
  env: Env,
  tripId: string,
  blobId: string,
  body: ReadableStream<Uint8Array>,
  length: number,
): Promise<void> {
  if (length > MAX_BLOB_BYTES) throw new BlobTooLargeError();
  const fixed = new FixedLengthStream(length);
  const piped = body.pipeTo(fixed.writable);
  const put = env.BLOBS.put(blobKey(tripId, blobId), fixed.readable, { onlyIf: CREATE_ONLY });
  const [pipeRes, putRes] = await Promise.allSettled([piped, put]);
  if (putRes.status === 'fulfilled' && pipeRes.status === 'fulfilled') {
    if (putRes.value === null) throw new BlobExistsError();
    return;
  }
  throw new BlobTooLargeError();
}

export async function getBlob(
  env: Env,
  tripId: string,
  blobId: string,
): Promise<ReadableStream | null> {
  const obj = await env.BLOBS.get(blobKey(tripId, blobId));
  return obj?.body ?? null;
}
