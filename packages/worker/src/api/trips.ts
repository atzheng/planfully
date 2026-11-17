import { Hono } from 'hono';
import type { Env } from '../env';

export const tripsRouter = new Hono<{ Bindings: Env }>();
