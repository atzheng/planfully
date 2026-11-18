import type { ParsedEmail } from './emailModel';
import type { ParseResponse } from './emailParse.worker';

export type EmailParse = { promise: Promise<ParsedEmail>; cancel: () => void };

/**
 * Parse an .eml off the main thread. Falls back to parsing in place when Workers are unavailable
 * (older browsers, jsdom). Both postal-mime and the worker are lazy chunks.
 */
export const PARSE_TIMEOUT_MS = 15_000;

export function parseEmail(data: ArrayBuffer, timeoutMs = PARSE_TIMEOUT_MS): EmailParse {
  if (typeof Worker === 'undefined') {
    return {
      promise: import('postal-mime').then(
        async ({ default: PostalMime }) => (await PostalMime.parse(data)) as unknown as ParsedEmail,
      ),
      cancel: () => {},
    };
  }
  const worker = new Worker(new URL('./emailParse.worker.ts', import.meta.url), { type: 'module' });
  const promise = new Promise<ParsedEmail>((resolve, reject) => {
    const fail = (why: string) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(why));
    };
    const timer = setTimeout(() => fail('parse timed out'), timeoutMs);
    worker.onmessageerror = () => fail('message error');
    worker.onmessage = (ev: MessageEvent<ParseResponse>) => {
      clearTimeout(timer);
      worker.terminate();
      if (ev.data.email) resolve(ev.data.email);
      else reject(new Error('parse failed'));
    };
    worker.onerror = () => fail('worker failed');
    worker.postMessage({ id: 0, data }, [data]);
  });
  return { promise, cancel: () => worker.terminate() };
}
