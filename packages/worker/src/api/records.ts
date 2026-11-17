import { Hono } from 'hono';
import type { Env } from '../env';

export const recordsRouter = new Hono<{ Bindings: Env }>();
