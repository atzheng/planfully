// Attachment blobs (CONTRACTS.md sections 4, 5, 7). The sealed bytes come from the server and
// are opened here with the trip's private key; the server never sees plaintext.

import { open, type Attachment } from '@planfully/shared';
import { getBlob } from '../lib/api';

export type AttachmentContext = { tripId: string; accessToken: string; privateKey: Uint8Array };

/** Fetch a sealed blob, open it in memory and wrap it with the attachment's mime type. */
export async function fetchAttachment(a: Attachment, ctx: AttachmentContext): Promise<Blob> {
  const sealed = await getBlob({ tripId: ctx.tripId, accessToken: ctx.accessToken }, a.id);
  const plain = await open(ctx.privateKey, sealed);
  return new Blob([plain as BlobPart], { type: a.mime });
}
