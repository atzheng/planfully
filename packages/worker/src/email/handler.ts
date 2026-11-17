import PostalMime, { decodeWords } from 'postal-mime';
import { fromBase64Url, seal } from '@planfully/shared';
import type { Attachment } from '@planfully/shared';
import { getTripByAddress } from '../db/trips';
import type { TripRow } from '../db/trips';
import type { Env } from '../env';
import { putBlob } from '../storage/blobs';
import { passesAuth, senderAddress } from './auth';
import { defaultRoute } from './routes/default';
import { receiptsRoute } from './routes/receipts';
import type { EmailRoute, ParsedEmail } from './types';

/** Suffix -> route. '' is the default. Exported so tests can substitute routes. */
export const routes: Record<string, EmailRoute | undefined> & { '': EmailRoute } = {
  '': defaultRoute,
  receipts: receiptsRoute,
};

/** Never log content: only error names. */
function logFailure(stage: string, err: unknown): void {
  console.error(`email ${stage} failed: ${err instanceof Error ? err.name : 'unknown'}`);
}

/** Splits `local+suffix@domain` into the trip address and the lowercased suffix. */
export function splitRecipient(
  to: string,
): { address: string; suffix: string; domain: string } | null {
  const at = to.lastIndexOf('@');
  if (at < 1) return null;
  const local = to.slice(0, at).toLowerCase();
  const domain = to.slice(at + 1).toLowerCase();
  const plus = local.indexOf('+');
  const base = plus === -1 ? local : local.slice(0, plus);
  const suffix = plus === -1 ? '' : local.slice(plus + 1);
  if (!base) return null;
  return { address: `${base}@${domain}`, suffix, domain };
}

function fileNameFromSubject(raw: string | null): string {
  let subject: string;
  try {
    subject = decodeWords(raw ?? '');
  } catch {
    subject = raw ?? '';
  }
  const clean = subject
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${clean.slice(0, 100).trim() || 'email'}.eml`;
}

async function readAll(message: ForwardableEmailMessage): Promise<Uint8Array> {
  return new Uint8Array(await new Response(message.raw).arrayBuffer());
}

function toParsed(
  parsed: Awaited<ReturnType<typeof PostalMime.parse>>,
  from: string,
  to: string,
  suffix: string,
  sourceAttachment: Attachment,
): ParsedEmail {
  return {
    from,
    to,
    suffix,
    subject: parsed.subject ?? '',
    date: parsed.date ?? '',
    text: parsed.text,
    html: parsed.html,
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? 'attachment',
      mime: a.mimeType,
      // Default attachmentEncoding gives binary content: no string round trip.
      bytes:
        a.content instanceof Uint8Array
          ? a.content
          : typeof a.content === 'string'
            ? new TextEncoder().encode(a.content)
            : new Uint8Array(a.content),
    })),
    sourceAttachment,
  };
}

/**
 * Entry point for inbound mail (SPEC.md section 5). Unknown address: reject.
 * Sender not allowed or unauthenticated: drop silently. Otherwise seal and store the
 * raw message, then parse and run the route for the suffix inside ctx.waitUntil.
 */
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const rcpt = splitRecipient(message.to);
  if (!rcpt || rcpt.domain !== env.TRIP_DOMAIN.toLowerCase()) {
    message.setReject('unknown address');
    return;
  }
  const trip = await getTripByAddress(env, rcpt.address);
  if (!trip) {
    message.setReject('unknown address');
    return;
  }

  const from = senderAddress(message.headers.get('from'));
  if (!from || !trip.allowedSenders.includes(from)) return;
  if (!passesAuth(message.headers.get('authentication-results'), from)) return;

  let sourceAttachment: Attachment;
  let raw: Uint8Array;
  try {
    raw = await readAll(message);
    const sealed = await seal(fromBase64Url(trip.publicKey), raw);
    const id = crypto.randomUUID();
    await putBlob(env, trip.id, id, sealed);
    sourceAttachment = {
      id,
      filename: fileNameFromSubject(message.headers.get('subject')),
      mime: 'message/rfc822',
      size: raw.byteLength,
      kind: 'source-email',
    };
  } catch (err) {
    logFailure('store', err);
    return;
  }

  ctx.waitUntil(runRoute(env, trip, raw, from, message.to, rcpt.suffix, sourceAttachment));
}

async function runRoute(
  env: Env,
  trip: TripRow,
  raw: Uint8Array,
  from: string,
  to: string,
  suffix: string,
  sourceAttachment: Attachment,
): Promise<void> {
  try {
    const parsed = await PostalMime.parse(raw);
    const email = toParsed(parsed, from, to, suffix, sourceAttachment);
    const route = routes[suffix] ?? routes[''];
    await route({ env, trip, email });
  } catch (err) {
    logFailure('route', err);
  }
}
