// Attachment blobs (CONTRACTS.md sections 4, 5, 7). The sealed bytes come from the server and
// are opened here with the trip's private key; the server never sees plaintext. Sealed bytes
// are also kept in the offline cache (offline/db.ts), so an opened attachment works offline.

import { open, seal, type Attachment } from '@planfully/shared';
import { getBlob, putBlob } from '../lib/api';
import { getOfflineDb, safely, type OfflineDb } from '../offline/db';
import type { TripQueue } from '../offline/queue';

export type AttachmentContext = { tripId: string; accessToken: string; privateKey: Uint8Array };

/** Attachments under this size are cached in the background after a sync; larger ones when opened. */
export const PREFETCH_MAX_BYTES = 5 * 1024 * 1024;

/** Fetch a sealed blob (cache first), open it in memory and wrap it with the attachment's mime type. */
export async function fetchAttachment(a: Attachment, ctx: AttachmentContext): Promise<Blob> {
  const cache = getOfflineDb();
  let sealed = cache ? await safely(() => cache.getBlob(a.id)) : undefined;
  if (!sealed) {
    const fetched = await getBlob({ tripId: ctx.tripId, accessToken: ctx.accessToken }, a.id);
    sealed = fetched;
    if (cache) await safely(() => cache.putBlob(ctx.tripId, a.id, fetched));
  }
  const plain = await open(ctx.privateKey, sealed);
  return new Blob([plain as BlobPart], { type: a.mime });
}

/** Background: cache the sealed bytes of small attachments not cached yet. Never throws. */
export async function prefetchAttachments(
  attachments: Attachment[],
  ctx: { tripId: string; accessToken: string },
  cache: OfflineDb,
  fetchBlob: (id: string) => Promise<Uint8Array> = (id) => getBlob(ctx, id),
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  for (const a of attachments) {
    if (!shouldContinue()) return;
    if (a.size >= PREFETCH_MAX_BYTES) continue;
    const have = await safely(() => cache.hasBlob(a.id));
    if (have !== false) continue;
    try {
      const sealed = await fetchBlob(a.id);
      if (shouldContinue()) await safely(() => cache.putBlob(ctx.tripId, a.id, sealed));
    } catch {
      // offline or gone: try again after a later sync
    }
  }
}

// Upload (planfully-ecw.4).

/** The Worker rejects sealed blobs over 25 MB; sealing adds 61 bytes (version, key, nonce, tag). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 - 61;

export type UploadContext = AttachmentContext & {
  publicKey: Uint8Array;
  /** Offline queue (from `getTripQueue(store)`): the sealed blob is queued and sent in order. Without it the PUT is direct. */
  queue?: TripQueue;
};

export class FileTooLargeError extends Error {
  constructor(filename: string) {
    super(`${filename} is larger than 25 MB and cannot be attached.`);
  }
}

/** Seal a file to the trip public key, PUT it as a new blob and describe it. */
export async function uploadAttachment(file: File, ctx: UploadContext): Promise<Attachment> {
  if (file.size > MAX_UPLOAD_BYTES) throw new FileTooLargeError(file.name);
  const plain = new Uint8Array(await file.arrayBuffer());
  const sealed = await seal(ctx.publicKey, plain);
  const id = crypto.randomUUID();
  // Best-effort: the file is then available offline at once (also before it is sent).
  const cache = getOfflineDb();
  if (cache) await safely(() => cache.putBlob(ctx.tripId, id, sealed));
  // Queued first, so it is sent before the record that will reference it; offline it stays queued.
  if (ctx.queue) await ctx.queue.enqueueBlob(id, sealed);
  else await putBlob({ tripId: ctx.tripId, accessToken: ctx.accessToken }, id, sealed);
  return {
    kind: 'file',
    id,
    filename: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
  };
}
