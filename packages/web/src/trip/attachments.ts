// Attachment blobs (CONTRACTS.md sections 4, 5, 7). The sealed bytes come from the server and
// are opened here with the trip's private key; the server never sees plaintext.

import { open, seal, type Attachment } from '@planfully/shared';
import { getBlob, putBlob } from '../lib/api';

export type AttachmentContext = { tripId: string; accessToken: string; privateKey: Uint8Array };

/** Fetch a sealed blob, open it in memory and wrap it with the attachment's mime type. */
export async function fetchAttachment(a: Attachment, ctx: AttachmentContext): Promise<Blob> {
  const sealed = await getBlob({ tripId: ctx.tripId, accessToken: ctx.accessToken }, a.id);
  const plain = await open(ctx.privateKey, sealed);
  return new Blob([plain as BlobPart], { type: a.mime });
}

// Upload (planfully-ecw.4).

/** The Worker rejects sealed blobs over 25 MB; sealing adds 61 bytes (version, key, nonce, tag). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024 - 61;

export type UploadContext = AttachmentContext & { publicKey: Uint8Array };

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
  await putBlob({ tripId: ctx.tripId, accessToken: ctx.accessToken }, id, sealed);
  return {
    kind: 'file',
    id,
    filename: file.name,
    mime: file.type || 'application/octet-stream',
    size: file.size,
  };
}
