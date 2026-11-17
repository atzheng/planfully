import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  BlobExistsError,
  BlobTooLargeError,
  getBlob,
  isBlobId,
  MAX_BLOB_BYTES,
  putBlobStream,
} from '../storage/blobs';
import type { TripEnv } from './auth';

export const blobsRouter = new Hono<TripEnv>();

function blobId(raw: string | undefined): string {
  if (!raw || !isBlobId(raw)) throw new HTTPException(400, { message: 'invalid blob id' });
  return raw;
}

// Content-Length is required (411 otherwise): R2 needs a known length to stream,
// and buffering up to 25 MB in a Worker is avoided deliberately.
blobsRouter.put('/:blobId', async (c) => {
  const id = blobId(c.req.param('blobId'));
  const raw = c.req.header('Content-Length');
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new HTTPException(411, { message: 'Content-Length required' });
  }
  const length = Number(raw);
  if (length > MAX_BLOB_BYTES) throw new HTTPException(413, { message: 'blob too large' });
  const body = c.req.raw.body;
  if (!body && length > 0) throw new HTTPException(400, { message: 'body required' });
  try {
    await putBlobStream(c.env, c.get('trip').id, id, body ?? new Blob([]).stream(), length);
  } catch (e) {
    if (e instanceof BlobExistsError) throw new HTTPException(409, { message: 'blob exists' });
    if (e instanceof BlobTooLargeError) {
      throw new HTTPException(413, { message: 'body too large or does not match Content-Length' });
    }
    throw e;
  }
  return c.body(null, 201);
});

blobsRouter.get('/:blobId', async (c) => {
  const stream = await getBlob(c.env, c.get('trip').id, blobId(c.req.param('blobId')));
  if (!stream) throw new HTTPException(404, { message: 'not found' });
  return new Response(stream, { headers: { 'Content-Type': 'application/octet-stream' } });
});
