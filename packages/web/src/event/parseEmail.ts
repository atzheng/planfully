import type { ParsedEmail } from './emailModel';
import type { ParseResponse } from './emailParse.worker';

export type EmailParse = { promise: Promise<ParsedEmail>; cancel: () => void };

/**
 * Parse an .eml off the main thread. Falls back to parsing in place when Workers are unavailable
 * (older browsers, jsdom). Both postal-mime and the worker are lazy chunks.
 */
export function parseEmail(data: ArrayBuffer): EmailParse {
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
    worker.onmessage = (ev: MessageEvent<ParseResponse>) => {
      worker.terminate();
      if (ev.data.email) resolve(ev.data.email);
      else reject(new Error('parse failed'));
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('worker failed'));
    };
    worker.postMessage({ id: 0, data }, [data]);
  });
  return { promise, cancel: () => worker.terminate() };
}
