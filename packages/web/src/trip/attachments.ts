// Attachment blobs (CONTRACTS.md sections 4, 5, 7). The sealed bytes come from the server and
// are opened here with the trip's private key; the server never sees plaintext. Sealed bytes
// are also kept in the offline cache (offline/db.ts), so an opened attachment works offline.

import { open, type Attachment } from '@planfully/shared';
import { getBlob } from '../lib/api';
import { getOfflineDb, safely, type OfflineDb } from '../offline/db';

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
