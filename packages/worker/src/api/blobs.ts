import { Hono } from 'hono';
import type { Env } from '../env';

export const blobsRouter = new Hono<{ Bindings: Env }>();
