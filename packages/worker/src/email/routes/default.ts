import { dayKey, dedupeTag, fromBase64 } from '@planfully/shared';
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

const AIRPORT_WORD =
  '(?:[Aa]irport|[Aa]eroporto|[Aa]éroport|[Aa]eropuerto|[Ff]lughafen|[Tt]erminal)';
const CODE_BEFORE_MARKER = new RegExp(
  `(?:^|[^A-Za-z])([A-Z]{3})\\s+(?:${AIRPORT_WORD}|T\\d)(?![A-Za-z0-9])`,
);
const CODE_AFTER_MARKER = new RegExp(`${AIRPORT_WORD}\\s+([A-Z]{3})(?![A-Za-z])`);

/**
 * A stable key for a place across emails. A 3-letter capital code counts only when it is
 * parenthesised "(CDG)", the whole trimmed name ("CDG"), or next to an airport marker
 * (Airport, Aeroporto, Aéroport, Aeropuerto, Flughafen, Terminal, or T<digit>) as in
 * "SFO Terminal 2" or "Airport JFK". Otherwise the name lowercased, diacritics stripped, with
 * everything but letters and digits removed ("Apolónia" == "Apolonia"). Ordinary all-caps words
 * (NEW YORK, AIR FRANCE) are therefore never mistaken for codes; "NYC JFK" gives "nycjfk".
 */
export function placeKey(loc: Location | undefined): string {
  const name = loc?.name?.trim() ?? '';
  const code =
    /\(([A-Z]{3})\)/.exec(name)?.[1] ??
    (/^[A-Z]{3}$/.test(name) ? name : undefined) ??
    CODE_BEFORE_MARKER.exec(name)?.[1] ??
    CODE_AFTER_MARKER.exec(name)?.[1];
  if (code) return code;
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Dedupe tag for a parsed event; null without a confirmation. See CONTRACTS.md section 3. */
export async function tagFor(
  dedupeKey: Uint8Array,
  e: Pick<ParsedEvent, 'type' | 'confirmation' | 'location' | 'endLocation' | 'start'>,
): Promise<string | null> {
  if (!e.confirmation) return null;
  const leg = TRANSPORT.has(e.type)
    ? `|${placeKey(e.location)}|${placeKey(e.endLocation)}|${e.start ? dayKey(e.start) : ''}`
    : '';
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
  failures: { count: number },
): Promise<Attachment | null> {
  let p = cache.get(index);
  if (!p) {
    const file = email.attachments[index];
    p = file
      ? storeAttachment(env, trip, file).catch((err: unknown) => {
          logFailure('attachment', err);
          failures.count++;
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
): Promise<{ appended: number; failed: boolean }> {
  const cache = new Map<number, Promise<Attachment | null>>();
  const failures = { count: 0 };
  let appended = 0;
  for (const p of parsed) {
    try {
      const { attachmentIndexes, ...fields } = p;
      const files: Attachment[] = [];
      for (const i of new Set(attachmentIndexes)) {
        const a = await storeFile(env, trip, email, i, cache, failures);
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
      failures.count++;
    }
  }
  return { appended, failed: failures.count > 0 };
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

/** Tells the user that part of the email could not be added. Best effort. */
async function notifyPartial(env: Env, trip: TripRow, email: ParsedEmail): Promise<void> {
  try {
    await appendEvent(
      env,
      trip,
      {
        id: crypto.randomUUID(),
        type: 'other',
        name: `Not everything from "${email.subject || '(no subject)'}" could be added`,
        needsReview: true,
        attachments: [email.sourceAttachment],
        participants: [],
        status: 'confirmed',
        source: 'email',
        createdAt: new Date().toISOString(),
      },
      null,
    );
  } catch (err) {
    logFailure('notice', err);
  }
}

/** Parse, geocode, dedupe, seal and append (SPEC.md section 5). */
export const defaultRoute: EmailRoute = async ({ env, trip, email }) => {
  const parsed = await parse(email, env, trip);
  const { appended, failed } = parsed.length
    ? await ingestEvents(env, trip, email, parsed)
    : { appended: 0, failed: false };
  if (appended === 0) await fallback(env, trip, email);
  else if (failed) await notifyPartial(env, trip, email);
};
