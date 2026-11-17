import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { searchPlaces, toLocation } from '../geo/geocode';
import type { TripEnv } from './auth';

export const geocodeRouter = new Hono<TripEnv>();

// GET /api/trips/:id/geocode?q= -> { results: Location[] } (up to 5). Auth is mounted in app.ts.
// Without GOOGLE_MAPS_SERVER_KEY, searchPlaces returns [] so the response is 200 { results: [] }.
geocodeRouter.get('/', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 3 || q.length > 200) {
    throw new HTTPException(400, { message: 'q must be 3 to 200 characters' });
  }
  const places = await searchPlaces(c.env, q, 5);
  return c.json({ results: places.map(toLocation) });
});
