import { app } from './api/app';
import type { Env } from './env';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  // Stub: planfully-2jd.1 replaces this.
  async email(message: ForwardableEmailMessage): Promise<void> {
    message.setReject('not configured');
  },
};
