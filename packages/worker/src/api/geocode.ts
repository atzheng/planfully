import { Hono } from 'hono';
import type { Env } from '../env';

export const geocodeRouter = new Hono<{ Bindings: Env }>();
