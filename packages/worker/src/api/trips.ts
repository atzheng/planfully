import { RosterMemberSchema, fromBase64Url, type TripMeta } from '@planfully/shared';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Env } from '../env';
import { createTrip, updateTrip, type TripRow } from '../db/trips';
import { requireAdmin, type TripEnv } from './auth';

const publicKey = z.string().refine((s) => {
  try {
    return fromBase64Url(s).length === 32;
  } catch {
    return false;
  }
}, 'publicKey must be 32 bytes, base64url');

const roster = z.array(RosterMemberSchema).max(50);

/** Trim, lowercase, drop empties and duplicates. */
const allowedSenders = z
  .array(z.string().max(320))
  .max(100)
  .transform((a) => [...new Set(a.map((s) => s.trim().toLowerCase()).filter(Boolean))]);

const name = z.string().trim().min(1).max(200);

const CreateBody = z.strictObject({
  name,
  publicKey,
  accessTokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  roster,
  allowedSenders,
});

const PatchBody = z.strictObject({
  name: name.optional(),
  roster: roster.optional(),
  allowedSenders: allowedSenders.optional(),
});

async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new HTTPException(400, { message: 'invalid JSON' });
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new HTTPException(400, { message: 'invalid body' });
  return r.data;
}

/** Public view of a trip; never includes dedupeKey or accessTokenHash. */
export function toTripMeta(row: TripRow, env: Env): TripMeta {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    domain: env.TRIP_DOMAIN,
    publicKey: row.publicKey,
    roster: row.roster,
    allowedSenders: row.allowedSenders,
    createdAt: row.createdAt,
  };
}

export const tripsRouter = new Hono<TripEnv>();

// Admin-guarded; not under :id so the access-token middleware does not apply.
tripsRouter.post('/', async (c) => {
  await requireAdmin(c.env, c.req.header('Authorization'));
  const body = await parseBody(c.req.raw, CreateBody);
  const row = await createTrip(c.env, body);
  return c.json({ id: row.id, address: row.address, domain: c.env.TRIP_DOMAIN }, 201);
});

tripsRouter.get('/:id', (c) => c.json(toTripMeta(c.get('trip'), c.env)));

tripsRouter.patch('/:id', async (c) => {
  const patch = await parseBody(c.req.raw, PatchBody);
  const row = await updateTrip(c.env, c.get('trip').id, patch);
  if (!row) throw new HTTPException(404, { message: 'not found' });
  return c.json(toTripMeta(row, c.env));
});
