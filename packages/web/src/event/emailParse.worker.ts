/// <reference lib="webworker" />
// Parses MIME off the main thread (planfully-311). Only parsing happens here; sanitising and srcdoc
// building stay on the main thread because they need DOMParser.
import PostalMime from 'postal-mime';
import type { ParsedEmail } from './emailModel';

export type ParseRequest = { id: number; data: ArrayBuffer };
export type ParseResponse = { id: number; email?: ParsedEmail; error?: true };

self.onmessage = async (ev: MessageEvent<ParseRequest>) => {
  const { id, data } = ev.data;
  try {
    const email = (await PostalMime.parse(data)) as unknown as ParsedEmail;
    const transfer = email.attachments
      .map((a) => a.content)
      .filter((c): c is ArrayBuffer => c instanceof ArrayBuffer);
    (self as unknown as Worker).postMessage({ id, email } satisfies ParseResponse, transfer);
  } catch {
    (self as unknown as Worker).postMessage({ id, error: true } satisfies ParseResponse);
  }
};
