import { env as baseEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import {
  deriveTripKeys,
  fold,
  fromBase64,
  generateSecret,
  openJson,
  toBase64Url,
} from '@planfully/shared';
import type { Attachment, OpenedRecord, RecordBody } from '@planfully/shared';
import { listRecords } from '../src/db/records';
import { getTripById } from '../src/db/trips';
import { handleEmail } from '../src/email/handler';
import { receiptsRoute } from '../src/email/routes/receipts';
import type { ParsedEmail } from '../src/email/types';
import * as llm from '../src/llm/parse';
import { applyMigrations, makeTrip } from './helpers';

beforeAll(applyMigrations);

const enc = new TextEncoder();
const source: Attachment = {
  id: crypto.randomUUID(),
  filename: 'mail.eml',
  mime: 'message/rfc822',
  size: 10,
  kind: 'source-email',
};

async function setup() {
  const keys = await deriveTripKeys(generateSecret());
  const row = await makeTrip({
    address: `t-${crypto.randomUUID().slice(0, 8)}@${baseEnv.TRIP_DOMAIN}`,
    public_key: toBase64Url(keys.publicKey),
    allowed_senders: JSON.stringify(['alice@example.com']),
  });
  const trip = await getTripById(baseEnv, row.id);
  if (!trip) throw new Error('trip missing');
  return { trip, keys };
}

function makeEmail(over: Partial<ParsedEmail> = {}): ParsedEmail {
  return {
    from: 'alice@example.com',
    to: 'trip@example.com',
    suffix: 'receipts',
    subject: 'Taxi receipt',
    date: 'Mon, 04 May 2026 10:30:00 +0200',
    attachments: [
      { filename: 'receipt.pdf', mime: 'application/pdf', bytes: enc.encode('%PDF-1.4 r') },
    ],
    sourceAttachment: source,
    ...over,
  };
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

describe('receipts route', () => {
  test('email with a PDF yields one receipt put with the PDF and source email', async () => {
    const { trip, keys } = await setup();
    const parse = vi.spyOn(llm, 'parseEmail');
    await receiptsRoute({ env: baseEnv, trip, email: makeEmail() });
    expect(parse).not.toHaveBeenCalled();
    const recs = await opened(trip.id, keys.privateKey);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.body.kind).toBe('put');
    expect(recs[0]?.dedupe).toBeNull();
    const [e] = fold(recs);
    expect(e?.type).toBe('receipt');
    expect(e?.name).toBe('Taxi receipt');
    expect(e?.start).toEqual({ local: '2026-05-04T08:30', tz: 'UTC' });
    expect(e?.source).toBe('email');
    expect(e?.status).toBe('confirmed');
    expect(e?.participants).toEqual([]);
    expect(e?.attachments.map((a) => [a.kind, a.filename])).toEqual([
      ['file', 'receipt.pdf'],
      ['source-email', 'mail.eml'],
    ]);
    expect(e?.attachments[1]?.id).toBe(source.id);
  });

  test('email without attachments gets the source email only, default name, bad date uses now', async () => {
    const { trip, keys } = await setup();
    const before = Date.now();
    await receiptsRoute({
      env: baseEnv,
      trip,
      email: makeEmail({ attachments: [], subject: '', date: 'garbage' }),
    });
    const [e] = fold(await opened(trip.id, keys.privateKey));
    expect(e?.name).toBe('Receipt');
    expect(e?.attachments.map((a) => a.kind)).toEqual(['source-email']);
    expect(e?.start?.tz).toBe('UTC');
    const ms = Date.parse(`${e?.start?.local}:00Z`);
    expect(Math.abs(ms - before)).toBeLessThan(120_000);
  });

  test('+receipts routes end to end through handleEmail without calling the LLM', async () => {
    const { trip, keys } = await setup();
    const parse = vi.spyOn(llm, 'parseEmail');
    const raw = [
      'From: alice@example.com',
      'Subject: Hotel folio',
      'Date: Tue, 05 May 2026 09:00:00 +0000',
      'Message-ID: <r1@example.com>',
      'Content-Type: text/plain',
      '',
      'thanks',
      '',
    ].join('\r\n');
    const bytes = enc.encode(raw);
    const headers = new Headers({
      from: 'alice@example.com',
      subject: 'Hotel folio',
      'authentication-results':
        'mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass',
    });
    const [local = ''] = trip.address.split('@');
    const message = {
      from: 'bounce@example.com',
      to: `${local}+receipts@${baseEnv.TRIP_DOMAIN}`,
      headers,
      raw: new Response(bytes).body as ReadableStream<Uint8Array>,
      rawSize: bytes.byteLength,
      setReject: vi.fn(),
    } as unknown as ForwardableEmailMessage;
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as ExecutionContext;
    await handleEmail(message, baseEnv, ctx);
    await Promise.all(pending);
    const [e] = fold(await opened(trip.id, keys.privateKey));
    expect(parse).not.toHaveBeenCalled();
    expect(e?.type).toBe('receipt');
    expect(e?.name).toBe('Hotel folio');
    expect(e?.start?.local).toBe('2026-05-05T09:00');
    expect(e?.attachments.map((a) => a.kind)).toEqual(['source-email']);
  });
});
