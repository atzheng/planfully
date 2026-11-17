import { dedupeTag, fromBase64 } from '@planfully/shared';
import type { Attachment, Event, Location, ParsedEvent } from '@planfully/shared';
import type { TripRow } from '../../db/trips';
import type { Env } from '../../env';
import { geocode } from '../../geo/geocode';
import { parseEmail } from '../../llm/parse';
import type { LlmClient } from '../../llm/parse';
import { BlobTooLargeError } from '../../storage/blobs';
import { appendEvent, storeAttachment } from '../store';
import type { EmailRoute, ParsedEmail } from '../types';

let testClient: LlmClient | undefined;
/** Test hook: parseEmail uses this client instead of a real one. Pass undefined to reset. */
export function setLlmClientForTests(client: LlmClient | undefined): void {
  testClient = client;
}

/** Never log content: only error names. */
function logFailure(stage: string, err: unknown): void {
  console.error(`ingest ${stage} failed: ${err instanceof Error ? err.name : 'unknown'}`);
}

/**
 * The reference date for year-less dates in the email: the Date header's UTC day when it
 * parses, otherwise today (UTC).
 */
export function todayFor(dateHeader: string): string {
  const t = Date.parse(dateHeader);
  return new Date(Number.isNaN(t) ? Date.now() : t).toISOString().slice(0, 10);
}

const TRANSPORT = new Set(['flight', 'train', 'bus', 'ferry', 'car']);

/**
 * A stable key for a place across emails: an IATA-style code when the name has one
 * ("San Francisco (SFO)", "SFO", "SFO Terminal 2" all give "SFO"), else the name with
 * everything but letters and digits removed and lowercased.
 */
export function placeKey(loc: Location | undefined): string {
  const name = loc?.name?.trim() ?? '';
  const code = /\(([A-Z]{3})\)/.exec(name) ?? /\b([A-Z]{3})\b/.exec(name);
  if (code?.[1]) return code[1];
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Dedupe tag for a parsed event; null without a confirmation. See CONTRACTS.md section 3. */
export async function tagFor(
  dedupeKey: Uint8Array,
  e: Pick<ParsedEvent, 'type' | 'confirmation' | 'location' | 'endLocation'>,
): Promise<string | null> {
  if (!e.confirmation) return null;
  const leg = TRANSPORT.has(e.type) ? `|${placeKey(e.location)}|${placeKey(e.endLocation)}` : '';
  return dedupeTag(dedupeKey, e.type, e.confirmation + leg);
}

async function parse(email: ParsedEmail, env: Env, trip: TripRow): Promise<ParsedEvent[]> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  try {
    return await parseEmail(email, {
      roster: trip.roster,
      today: todayFor(email.date),
      apiKey,
      client: testClient,
    });
  } catch (err) {
    logFailure('parse', err);
    return [];
  }
}

function storeFile(
  env: Env,
  trip: TripRow,
  email: ParsedEmail,
  index: number,
  cache: Map<number, Promise<Attachment | null>>,
): Promise<Attachment | null> {
  let p = cache.get(index);
  if (!p) {
    const file = email.attachments[index];
    p = file
      ? storeAttachment(env, trip, file).catch((err: unknown) => {
          logFailure('attachment', err);
          return null;
        })
      : Promise.resolve(null);
    cache.set(index, p);
  }
  return p;
}

/** Returns the number of events appended. One event failing does not stop the others. */
async function ingestEvents(
  env: Env,
  trip: TripRow,
  email: ParsedEmail,
  parsed: ParsedEvent[],
): Promise<number> {
  const cache = new Map<number, Promise<Attachment | null>>();
  let appended = 0;
  for (const p of parsed) {
    try {
      const { attachmentIndexes, ...fields } = p;
      const files: Attachment[] = [];
      for (const i of new Set(attachmentIndexes)) {
        const a = await storeFile(env, trip, email, i, cache);
        if (a) files.push(a);
      }
      const location = fields.location ? await geocode(env, fields.location) : undefined;
      const endLocation = fields.endLocation ? await geocode(env, fields.endLocation) : undefined;
      const event: Event = {
        ...fields,
        ...(location && { location }),
        ...(endLocation && { endLocation }),
        id: crypto.randomUUID(),
        attachments: [...files, email.sourceAttachment],
        source: 'email',
        createdAt: new Date().toISOString(),
      };
      await appendEvent(env, trip, event, await tagFor(fromBase64(trip.dedupeKey), fields));
      appended++;
    } catch (err) {
      logFailure('event', err);
    }
  }
  return appended;
}

/** One needs-review event holding the whole email. Throws if it cannot be stored. */
async function fallback(env: Env, trip: TripRow, email: ParsedEmail): Promise<void> {
  const files: Attachment[] = [];
  for (const f of email.attachments) {
    try {
      files.push(await storeAttachment(env, trip, f));
    } catch (err) {
      if (err instanceof BlobTooLargeError) continue;
      throw err;
    }
  }
  await appendEvent(
    env,
    trip,
    {
      id: crypto.randomUUID(),
      type: 'other',
      name: email.subject || '(no subject)',
      needsReview: true,
      attachments: [...files, email.sourceAttachment],
      participants: [],
      status: 'confirmed',
      source: 'email',
      createdAt: new Date().toISOString(),
    },
    null,
  );
}

/** Parse, geocode, dedupe, seal and append (SPEC.md section 5). */
export const defaultRoute: EmailRoute = async ({ env, trip, email }) => {
  const parsed = await parse(email, env, trip);
  const appended = parsed.length ? await ingestEvents(env, trip, email, parsed) : 0;
  if (appended === 0) await fallback(env, trip, email);
};
