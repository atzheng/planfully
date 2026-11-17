import { env as baseEnv } from 'cloudflare:workers';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  deriveTripKeys,
  fold,
  generateSecret,
  open,
  openJson,
  toBase64,
  toBase64Url,
  fromBase64,
} from '@planfully/shared';
import type { Attachment, Event, OpenedRecord, RecordBody } from '@planfully/shared';
import { listRecords } from '../src/db/records';
import { getTripById } from '../src/db/trips';
import {
  defaultRoute,
  placeKey,
  setLlmClientForTests,
  todayFor,
} from '../src/email/routes/default';
import { appendEvent } from '../src/email/store';
import type { ParsedEmail } from '../src/email/types';
import type { Env } from '../src/env';
import type { LlmClient } from '../src/llm/parse';
import { applyMigrations, makeTrip } from './helpers';

beforeAll(applyMigrations);
afterEach(() => {
  setLlmClientForTests(undefined);
  vi.restoreAllMocks();
});

const enc = new TextEncoder();
const SUBJECT = 'Your itinerary SECRET-SUBJECT-TEXT';
const BODY = 'Passenger details SECRET-BODY-TEXT';

async function setup() {
  const keys = await deriveTripKeys(generateSecret());
  const row = await makeTrip({
    public_key: toBase64Url(keys.publicKey),
    dedupe_key: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    roster: JSON.stringify([{ id: 'alice', name: 'Alice', aliases: [] }]),
  });
  const trip = await getTripById(baseEnv, row.id);
  if (!trip) throw new Error('trip missing');
  return { trip, keys };
}

const withKey = { ...baseEnv, ANTHROPIC_API_KEY: 'test-key' } as Env;
const noKey = { ...baseEnv, ANTHROPIC_API_KEY: undefined } as Env;

const source: Attachment = {
  id: crypto.randomUUID(),
  filename: 'mail.eml',
  mime: 'message/rfc822',
  size: 10,
  kind: 'source-email',
};

function makeEmail(over: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    from: 'alice@example.com',
    to: 'trip@example.com',
    suffix: '',
    subject: SUBJECT,
    date: 'Mon, 04 May 2026 10:00:00 +0000',
    text: BODY,
    attachments: [
      { filename: 'ticket.pdf', mime: 'application/pdf', bytes: enc.encode('%PDF-1.4 ticket') },
    ],
    sourceAttachment: source,
    ...over,
  };
}

function fakeClient(events: unknown[] | Error) {
  const create = vi.fn(async (_b: Anthropic.MessageCreateParamsNonStreaming) => {
    if (events instanceof Error) throw events;
    return {
      content: [{ type: 'text', text: JSON.stringify(events) }],
      stop_reason: 'end_turn',
    } as unknown as Anthropic.Message;
  });
  const client: LlmClient = { messages: { create } };
  return { client, create };
}

const leg = (over: Record<string, unknown> = {}) => ({
  name: 'UA 100 SFO to JFK',
  type: 'flight',
  start: { local: '2026-06-01T08:00', tz: 'America/Los_Angeles' },
  end: { local: '2026-06-01T16:30', tz: 'America/New_York' },
  confirmation: 'ABC123',
  location: { name: 'San Francisco (SFO)' },
  endLocation: { name: 'New York (JFK)' },
  participants: ['alice'],
  status: 'confirmed',
  attachmentIndexes: [0],
  ...over,
});
const leg2 = (over: Record<string, unknown> = {}) =>
  leg({
    name: 'UA 200 JFK to LHR',
    start: { local: '2026-06-01T20:00', tz: 'America/New_York' },
    end: { local: '2026-06-02T08:00', tz: 'Europe/London' },
    location: { name: 'New York (JFK)' },
    endLocation: { name: 'London Heathrow (LHR)' },
    ...over,
  });

async function ingest(
  trip: Awaited<ReturnType<typeof setup>>['trip'],
  events: unknown[] | Error,
  email = makeEmail(),
  e: Env = withKey,
) {
  setLlmClientForTests(fakeClient(events).client);
  await defaultRoute({ env: e, trip, email });
}

async function opened(tripId: string, privateKey: Uint8Array): Promise<OpenedRecord[]> {
  const stored = await listRecords(baseEnv, tripId, 0);
  return Promise.all(
    stored.map(async (r) => ({
      seq: r.seq,
      dedupe: r.dedupe,
      createdAt: r.createdAt,
      body: await openJson<RecordBody>(privateKey, fromBase64(r.ciphertext)),
    })),
  );
}

describe('default route', () => {
  test('two-leg flight yields two puts with the PDF and source email', async () => {
    const { trip, keys } = await setup();
    await ingest(trip, [leg(), leg2()]);
    const recs = await opened(trip.id, keys.privateKey);
    expect(recs).toHaveLength(2);
    expect(recs[0]?.dedupe).toMatch(/^[0-9a-f]{64}$/);
    expect(recs[0]?.dedupe).not.toBe(recs[1]?.dedupe);
    const events = fold(recs);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.source).toBe('email');
      expect(e.attachments.map((a) => a.kind)).toEqual(['file', 'source-email']);
      expect(e.attachments[1]?.id).toBe(source.id);
    }
    // one PDF stored once, shared by both legs, and decryptable
    expect(events[0]?.attachments[0]?.id).toBe(events[1]?.attachments[0]?.id);
    const blob = await baseEnv.BLOBS.get(`trips/${trip.id}/blobs/${events[0]?.attachments[0]?.id}`);
    if (!blob) throw new Error('blob missing');
    const plain = await open(keys.privateKey, new Uint8Array(await blob.arrayBuffer()));
    expect(new TextDecoder().decode(plain)).toBe('%PDF-1.4 ticket');
    expect(events[0]?.attachments[0]?.size).toBe(plain.byteLength);
  });

  test('schedule change with different airport naming folds into that leg only', async () => {
    const { trip, keys } = await setup();
    await ingest(trip, [leg(), leg2()]);
    await ingest(
      trip,
      [
        leg({
          start: { local: '2026-06-01T09:15', tz: 'America/Los_Angeles' },
          location: { name: 'SFO' },
          endLocation: { name: 'JFK Terminal 4' },
          attachmentIndexes: [],
        }),
      ],
      makeEmail({ attachments: [] }),
    );
    const events = fold(await opened(trip.id, keys.privateKey));
    expect(events).toHaveLength(2);
    const first = events.find((e) => e.name.includes('UA 100'));
    const second = events.find((e) => e.name.includes('UA 200'));
    expect(first?.start?.local).toBe('2026-06-01T09:15');
    expect(second?.start?.local).toBe('2026-06-01T20:00');
  });

  test('cancellation folds to status cancelled', async () => {
    const { trip, keys } = await setup();
    await ingest(trip, [leg()]);
    await ingest(trip, [leg({ status: 'cancelled', attachmentIndexes: [] })], makeEmail());
    const events = fold(await opened(trip.id, keys.privateKey));
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe('cancelled');
  });

  test('non-transport confirmation uses the plain confirmation', async () => {
    const { trip, keys } = await setup();
    const hotel = {
      name: 'Hotel Ritz',
      type: 'lodging',
      confirmation: 'H-77',
      participants: [],
      status: 'confirmed',
      attachmentIndexes: [],
    };
    await ingest(trip, [hotel]);
    await ingest(trip, [{ ...hotel, location: { name: 'Ritz Paris' } }]);
    const events = fold(await opened(trip.id, keys.privateKey));
    expect(events).toHaveLength(1);
  });

  test.each([
    ['parser throws', new Error('boom'), withKey],
    ['parser returns []', [], withKey],
    ['no api key', [leg()], noKey],
  ])('%s: one needs-review event with all attachments', async (_n, events, e) => {
    const { trip, keys } = await setup();
    const email = makeEmail({
      attachments: [
        { filename: 'a.pdf', mime: 'application/pdf', bytes: enc.encode('A') },
        { filename: 'b.png', mime: 'image/png', bytes: enc.encode('B') },
      ],
    });
    await ingest(trip, events as unknown[] | Error, email, e);
    const recs = await opened(trip.id, keys.privateKey);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.dedupe).toBeNull();
    const [ev] = fold(recs) as [Event];
    expect(ev.needsReview).toBe(true);
    expect(ev.type).toBe('other');
    expect(ev.name).toBe(SUBJECT);
    expect(ev.attachments.map((a) => a.filename)).toEqual(['a.pdf', 'b.png', 'mail.eml']);
  });

  test('appendEvent rejects an event that fails EventSchema and writes nothing', async () => {
    const { trip } = await setup();
    const bad = { id: 'x', name: '', type: 'flight' } as unknown as Event;
    await expect(appendEvent(baseEnv, trip, bad, null)).rejects.toThrow();
    expect(await listRecords(baseEnv, trip.id, 0)).toHaveLength(0);
  });

  test('all events failing falls back', async () => {
    const { trip, keys } = await setup();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // trip row pointing at a bad public key is overkill: break the dedupe key instead
    const bad = { ...trip, dedupeKey: '!!!notbase64' };
    setLlmClientForTests(fakeClient([leg()]).client);
    await defaultRoute({ env: withKey, trip: bad, email: makeEmail() });
    const events = fold(await opened(trip.id, keys.privateKey));
    expect(events).toHaveLength(1);
    expect(events[0]?.needsReview).toBe(true);
    spy.mockRestore();
  });

  test('skips an oversized attachment in the fallback', async () => {
    const { trip, keys } = await setup();
    const huge = new Uint8Array(25 * 1024 * 1024);
    const email = makeEmail({
      attachments: [
        { filename: 'huge.bin', mime: 'application/octet-stream', bytes: huge },
        { filename: 'ok.pdf', mime: 'application/pdf', bytes: enc.encode('ok') },
      ],
    });
    await ingest(trip, [], email);
    const [ev] = fold(await opened(trip.id, keys.privateKey)) as [Event];
    expect(ev.attachments.map((a) => a.filename)).toEqual(['ok.pdf', 'mail.eml']);
  });

  test('logs no email or event content', async () => {
    const { trip } = await setup();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    await ingest(trip, new Error(`failed on ${SUBJECT} ${BODY}`));
    await ingest(trip, [leg({ name: '' })]);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toMatch(/SECRET|UA 100|ABC123|SFO/);
  });
});

describe('review fixes', () => {
  const train = (day: string, over: Record<string, unknown> = {}) => ({
    name: `Train ${day}`,
    type: 'train',
    start: { local: `2026-06-${day}T09:00`, tz: 'Europe/Lisbon' },
    confirmation: 'TRN777',
    location: { name: 'Lisboa Santa Apolónia' },
    endLocation: { name: 'Porto Campanhã' },
    participants: [],
    status: 'confirmed',
    attachmentIndexes: [],
    ...over,
  });

  test('same route on two days with one confirmation stays two events', async () => {
    const { trip, keys } = await setup();
    await ingest(trip, [train('01'), train('02')]);
    expect(fold(await opened(trip.id, keys.privateKey))).toHaveLength(2);
  });

  test('same-day change and cancellation fold; moving to another day duplicates', async () => {
    const { trip, keys } = await setup();
    await ingest(trip, [train('01')]);
    await ingest(trip, [
      train('01', {
        start: { local: '2026-06-01T11:30', tz: 'Europe/Lisbon' },
        location: { name: 'Lisboa Santa Apolonia' },
      }),
    ]);
    let events = fold(await opened(trip.id, keys.privateKey));
    expect(events).toHaveLength(1);
    expect(events[0]?.start?.local).toBe('2026-06-01T11:30');
    await ingest(trip, [train('01', { status: 'cancelled' })]);
    events = fold(await opened(trip.id, keys.privateKey));
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe('cancelled');
    await ingest(trip, [train('03')]);
    expect(fold(await opened(trip.id, keys.privateKey))).toHaveLength(2);
  });

  test('partial failure appends a needs-review notice', async () => {
    const { trip, keys } = await setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(baseEnv.BLOBS, 'put').mockRejectedValueOnce(new Error('r2 down'));
    await ingest(trip, [leg()]);
    const events = fold(await opened(trip.id, keys.privateKey));
    expect(events).toHaveLength(2);
    const notice = events.find((e) => e.needsReview);
    expect(notice?.name).toBe(`Not everything from "${SUBJECT}" could be added`);
    expect(notice?.attachments).toEqual([source]);
    expect(events.find((e) => !e.needsReview)?.attachments).toEqual([source]);
  });
});

describe('helpers', () => {
  test('placeKey', () => {
    for (const n of ['San Francisco (SFO)', 'SFO', 'SFO Terminal 2', 'Airport SFO', 'SFO T2'])
      expect(placeKey({ name: n })).toBe('SFO');
    expect(placeKey({ name: 'Paris Charles de Gaulle (CDG)' })).toBe(placeKey({ name: 'CDG' }));
    expect(placeKey({ name: 'NEW YORK' })).toBe('newyork');
    expect(placeKey({ name: 'LOS ANGELES' })).toBe('losangeles');
    expect(placeKey({ name: 'AIR FRANCE' })).toBe('airfrance');
    expect(placeKey({ name: 'SAN FRANCISCO' })).not.toBe(placeKey({ name: 'SAN DIEGO' }));
    expect(placeKey({ name: 'Apolónia' })).toBe(placeKey({ name: 'Apolonia' }));
    expect(placeKey({ name: 'NYC JFK' })).toBe('nycjfk');
    expect(placeKey(undefined)).toBe('');
  });
  test('todayFor uses the Date header when valid', () => {
    expect(todayFor('Mon, 04 May 2026 10:00:00 +0000')).toBe('2026-05-04');
    expect(todayFor('garbage')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
