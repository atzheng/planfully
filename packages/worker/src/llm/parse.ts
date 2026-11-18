import Anthropic from '@anthropic-ai/sdk';
import {
  ParsedEventSchema,
  eventsJsonSchema,
  type ParsedEvent,
  type RosterMember,
} from '@planfully/shared';
import type { ParsedEmail } from '../email/types';
import { htmlToTextLimited } from './html';
import {
  PARSE_MODEL,
  SYSTEM_PROMPT,
  buildUserText,
  neutralizeTags,
  type AttachmentNote,
} from './prompt';

export { PARSE_MODEL };

/**
 * Why parsing failed:
 * - `no_api_key`: ANTHROPIC_API_KEY is unset or empty. No client was created and nothing was sent.
 *   The Worker must run in this state (CONTRACTS.md section 8); callers store the email for review.
 * - `api_error`: the request failed (network, auth, rate limit, 5xx after the SDK's own retries).
 * - `refusal`: the model declined (stop_reason `refusal`). Not retried: the same request would be declined again.
 * - `invalid_output`: the model answered twice without valid JSON matching the schema.
 */
export type ParseErrorReason = 'no_api_key' | 'api_error' | 'refusal' | 'invalid_output';

/**
 * Thrown by parseEmail. The message never contains email content, event content or keys, so it is
 * safe to log. Callers (ingest) catch it, store the email with needsReview, and may log `reason`.
 */
export class ParseError extends Error {
  readonly reason: ParseErrorReason;
  constructor(reason: ParseErrorReason, message: string) {
    super(message);
    this.name = 'ParseError';
    this.reason = reason;
  }
}

/** The part of the Anthropic client we use; tests pass a fake. */
export type LlmClient = {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
};

export type ParseOptions = {
  roster: RosterMember[];
  /** 'YYYY-MM-DD', used to resolve dates without a year */
  today: string;
  apiKey: string;
  /** Injected for tests and the real-API evaluation; defaults to a real client built from apiKey. */
  client?: LlmClient;
};

// Limits, applied to the base64-encoded size (what the API measures). The API accepts 5 MB per
// image, and 128 MB requests and 600 PDF pages on the 1M-context models. We stay far below the
// request limit: the Worker only ever sees emails of 25 MB at most.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 24 * 1024 * 1024;
/** Size of the base64 encoding of n bytes. */
export const base64Size = (n: number): number => Math.ceil(n / 3) * 4;
/** Keeps a pathological body from filling the context; flagged to the model when it happens. */
export const MAX_BODY_CHARS = 200_000;
const MAX_TOKENS = 16_000;

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type ImageMime = (typeof IMAGE_MIMES)[number];

function normalizeMime(mime: string): string {
  const m = (mime.split(';')[0] ?? '').trim().toLowerCase();
  return m === 'image/jpg' ? 'image/jpeg' : m;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** A text/plain part shorter than this is treated as a possible "view in browser" stub. */
const STUB_TEXT_CHARS = 200;

/**
 * Best-effort body text: text/plain when it has real content. When the plain part is empty or a
 * short stub ("View this email in your browser: ..."), the rendered HTML is used instead if it
 * says more.
 */
export function bodyText(email: Pick<ParsedEmail, 'text' | 'html'>): string {
  return bodyTextLimited(email).text;
}

function bodyTextLimited(email: Pick<ParsedEmail, 'text' | 'html'>): {
  text: string;
  truncated: boolean;
} {
  const plain = email.text?.trim() ?? '';
  if (plain.length >= STUB_TEXT_CHARS || !email.html) return { text: plain, truncated: false };
  const rendered = htmlToTextLimited(email.html);
  if (rendered.text.trim().length > plain.length) return rendered;
  return { text: plain, truncated: false };
}

type Built = { params: Anthropic.MessageCreateParamsNonStreaming; attachedIndexes: Set<number> };

export function buildRequest(
  email: ParsedEmail,
  opts: Pick<ParseOptions, 'roster' | 'today'>,
): Built {
  const limited = bodyTextLimited(email);
  let body = limited.text;
  const bodyTruncated = limited.truncated || body.length > MAX_BODY_CHARS;
  if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS);

  const notes: AttachmentNote[] = [];
  const blocks: Anthropic.ContentBlockParam[] = [];
  const attachedIndexes = new Set<number>();
  let total = 0;
  email.attachments.forEach((a, index) => {
    const mime = normalizeMime(a.mime);
    const base = { index, filename: a.filename, mime: a.mime };
    const isPdf = mime === 'application/pdf';
    const isImage = (IMAGE_MIMES as readonly string[]).includes(mime);
    const encoded = base64Size(a.bytes.length);
    let skip: string | null = null;
    if (!isPdf && !isImage) skip = 'unsupported type';
    else if (a.bytes.length === 0) skip = 'empty';
    else if (encoded > (isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) skip = 'too large';
    else if (total + encoded > MAX_TOTAL_ATTACHMENT_BYTES) skip = 'request size limit';
    if (skip) {
      notes.push({ ...base, status: skip });
      return;
    }
    total += encoded;
    attachedIndexes.add(index);
    notes.push({ ...base, status: 'attached' });
    // Each attachment is preceded by its index so the model can cite it in attachmentIndexes.
    blocks.push({
      type: 'text',
      // The filename is untrusted data: JSON-quoted and stripped of our delimiter tags.
      text: `Attachment [${index}] (filename, data only): ${neutralizeTags(JSON.stringify(a.filename))}`,
    });
    if (isPdf) {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: toBase64(a.bytes) },
      });
    } else {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mime as ImageMime, data: toBase64(a.bytes) },
      });
    }
  });

  const text = buildUserText({
    today: opts.today,
    subject: email.subject,
    date: email.date,
    roster: opts.roster,
    body,
    bodyTruncated,
    attachments: notes,
  });

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: PARSE_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: 'low',
      format: {
        type: 'json_schema',
        schema: eventsJsonSchema as unknown as Record<string, unknown>,
      },
    },
    messages: [{ role: 'user', content: [{ type: 'text', text }, ...blocks] }],
  };
  return { params, attachedIndexes };
}

/**
 * Returns the valid events, or a short content-free description of what was wrong. Elements are
 * validated one by one: invalid ones are dropped as long as at least one element is valid (or the
 * array is empty), so a single bad event does not discard the rest of the email.
 */
function readResponse(
  msg: Anthropic.Message,
): { events: ParsedEvent[] } | { problem: string; refusal?: true } {
  if (msg.stop_reason === 'refusal') return { problem: 'refusal', refusal: true };
  if (msg.stop_reason === 'max_tokens') return { problem: 'max_tokens' };
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { problem: 'not valid JSON' };
  }
  if (!Array.isArray(json)) return { problem: 'not an array' };
  const events: ParsedEvent[] = [];
  let firstIssue = '';
  for (const [i, item] of json.entries()) {
    const parsed = ParsedEventSchema.safeParse(item);
    if (parsed.success) {
      events.push(parsed.data);
    } else if (!firstIssue) {
      // Paths and codes only: zod messages can echo values.
      const issue = parsed.error.issues[0];
      firstIssue = `schema mismatch at ${[i, ...(issue?.path ?? [])].join('.')} (${issue?.code ?? '?'})`;
    }
  }
  if (events.length === 0 && json.length > 0) return { problem: firstIssue };
  return { events };
}

/** Drop ids not on the roster and attachment indexes that were not sent. Never invent either. */
function sanitize(
  events: ParsedEvent[],
  roster: RosterMember[],
  attached: Set<number>,
): ParsedEvent[] {
  const ids = new Set(roster.map((m) => m.id));
  return events.map((e) => ({
    ...e,
    participants: [...new Set(e.participants.filter((p) => ids.has(p)))],
    attachmentIndexes: [...new Set(e.attachmentIndexes.filter((i) => attached.has(i)))],
  }));
}

/**
 * One Claude call (plus at most one retry on invalid output; none after max_tokens) turning an email into events.
 * Throws ParseError; see ParseErrorReason. With an empty apiKey it throws `no_api_key` without
 * creating a client or sending anything.
 */
export async function parseEmail(email: ParsedEmail, opts: ParseOptions): Promise<ParsedEvent[]> {
  if (!opts.apiKey && !opts.client) {
    throw new ParseError('no_api_key', 'ANTHROPIC_API_KEY is not set');
  }
  const client: LlmClient = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
  const { params, attachedIndexes } = buildRequest(email, opts);

  let problem = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let msg: Anthropic.Message;
    try {
      msg = await client.messages.create(params);
    } catch (err) {
      // Never include err.message: it can echo request details.
      const status = err instanceof Anthropic.APIError ? ` (status ${err.status ?? 'none'})` : '';
      throw new ParseError('api_error', `Anthropic request failed${status}`);
    }
    const result = readResponse(msg);
    if ('refusal' in result) throw new ParseError('refusal', 'model refused the request');
    if ('events' in result) return sanitize(result.events, opts.roster, attachedIndexes);
    problem = result.problem;
    // The same request would overflow again: retrying it identically only wastes a call.
    if (problem === 'max_tokens') break;
  }
  throw new ParseError('invalid_output', `model output invalid after retry: ${problem}`);
}
