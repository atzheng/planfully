import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Env } from '../env';
import { blobsRouter } from './blobs';
import { geocodeRouter } from './geocode';
import { recordsRouter } from './records';
import { tripsRouter } from './trips';

export const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) => c.json({ ok: true }));

// Later beads fill these in. Sub-routers are mounted at the paths of CONTRACTS.md section 5.
app.route('/api/trips', tripsRouter);
app.route('/api/trips/:id/records', recordsRouter);
app.route('/api/trips/:id/blobs', blobsRouter);
app.route('/api/trips/:id/geocode', geocodeRouter);

app.notFound((c) => c.json({ error: 'not found' }, 404));

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  // Never log request, email or event content; the error name only.
  console.error('unhandled error', err.name);
  return c.json({ error: 'internal error' }, 500);
});
