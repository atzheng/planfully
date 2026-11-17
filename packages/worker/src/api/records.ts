import { fromBase64 } from '@planfully/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { MAX_PAGE, appendRecord, deleteRecord, listRecords } from '../db/records';
import type { TripEnv } from './auth';

/** Ciphertext limit, decoded bytes (CONTRACTS.md section 5). */
export const MAX_CIPHERTEXT_BYTES = 256 * 1024;
// base64 of the limit plus JSON framing and a dedupe tag; anything bigger is refused unread.
const MAX_BODY_CHARS = Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3) + 1024;

const AppendBody = z.strictObject({
  ciphertext: z.string().min(1),
  dedupe: z.string().max(256).nullish(),
});

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export const recordsRouter = new Hono<TripEnv>();

recordsRouter.get('/', async (c) => {
  const raw = c.req.query('since') ?? '0';
  if (!/^\d{1,15}$/.test(raw)) throw new HTTPException(400, { message: 'invalid since' });
  const since = Number(raw);
  // The counter was read (by the auth middleware) before the records: a record appended in
  // between is listed with seq > latestSeq, which is harmless (the next poll returns it again).
  const trip = c.get('trip');
  const rows = await listRecords(c.env, trip.id, since, MAX_PAGE + 1);
  const more = rows.length > MAX_PAGE;
  const records = more ? rows.slice(0, MAX_PAGE) : rows;
  // When the page is cut short, latestSeq is the last seq returned so polling with since=latestSeq
  // continues where this page ended; otherwise it is the trip counter (even if the tail was deleted).
  const latestSeq = more ? (records[records.length - 1]?.seq ?? since) : trip.nextSeq;
  return c.json({ records, latestSeq, more });
});

recordsRouter.post('/', async (c) => {
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_BODY_CHARS) throw new HTTPException(413, { message: 'record too large' });
  const text = await c.req.text();
  if (text.length > MAX_BODY_CHARS) throw new HTTPException(413, { message: 'record too large' });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON' });
  }
  const parsed = AppendBody.safeParse(json);
  if (!parsed.success) throw new HTTPException(400, { message: 'invalid body' });
  const { ciphertext, dedupe } = parsed.data;
  if (!BASE64.test(ciphertext)) {
    throw new HTTPException(400, { message: 'ciphertext is not base64' });
  }
  const bytes = fromBase64(ciphertext);
  if (bytes.length > MAX_CIPHERTEXT_BYTES) {
    throw new HTTPException(413, { message: 'record too large' });
  }
  const seq = await appendRecord(c.env, c.get('trip').id, { ciphertext: bytes, dedupe });
  return c.json({ seq }, 201);
});

// Deleting a seq that does not exist (or was already deleted) is 204: DELETE is idempotent, and a
// compaction retry after a partial failure must not error.
recordsRouter.delete('/:seq', async (c) => {
  const raw = c.req.param('seq');
  if (!/^\d{1,15}$/.test(raw)) throw new HTTPException(400, { message: 'invalid seq' });
  await deleteRecord(c.env, c.get('trip').id, Number(raw));
  return c.body(null, 204);
});
