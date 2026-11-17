import { hashAccessToken } from '@planfully/shared';
import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { Env } from '../env';
import { getTripById, type TripRow } from '../db/trips';

/** Hono env for routers under /api/trips/:id/*: `c.get('trip')` is the authenticated row. */
export type TripEnv = { Bindings: Env; Variables: { trip: TripRow } };

export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer +(\S+)$/i.exec(header ?? '');
  return m?.[1] ?? null;
}

/** Constant-time equality for strings of any length (compares SHA-256 digests). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 1);
  return diff === 0;
}

const unauthorized = () => new HTTPException(401, { message: 'unauthorized' });

/** Refuses when ADMIN_SECRET is unset/empty or the bearer token does not match. */
export async function requireAdmin(env: Env, header: string | undefined): Promise<void> {
  const token = bearerToken(header);
  if (!env.ADMIN_SECRET || !token || !(await safeEqual(token, env.ADMIN_SECRET))) {
    throw unauthorized();
  }
}

/**
 * Access-token auth for /api/trips/:id/*. Unknown trip and bad token are
 * indistinguishable (both 401). Sets `trip` on the context.
 */
export const requireTrip = createMiddleware<TripEnv>(async (c, next) => {
  const token = bearerToken(c.req.header('Authorization'));
  const trip = await getTripById(c.env, c.req.param('id') ?? '');
  // Always hash and compare, so timing does not reveal whether the trip exists.
  const hash = await hashAccessToken(token ?? '');
  const ok = await safeEqual(hash, trip?.accessTokenHash ?? '');
  if (!token || !trip || !ok) throw unauthorized();
  c.set('trip', trip);
  await next();
});
