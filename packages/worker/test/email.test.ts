import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { deriveTripKeys, generateSecret, open, toBase64Url } from '@planfully/shared';
import { passesAuth, senderAddress } from '../src/email/auth';
import { handleEmail, routes, splitRecipient } from '../src/email/handler';
import type { EmailRoute, ParsedEmail } from '../src/email/types';
import forwarded from './fixtures/emails/forwarded.eml?raw';
import html from './fixtures/emails/html.eml?raw';
import pdf from './fixtures/emails/pdf.eml?raw';
import plain from './fixtures/emails/plain.eml?raw';
import { applyMigrations, makeTrip } from './helpers';

beforeAll(applyMigrations);

const PASS =
  'mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=pass';
const enc = new TextEncoder();
const original = { ...routes };
afterEach(() => {
  Object.assign(routes, original);
  vi.restoreAllMocks();
});

async function setup(allowed = ['alice@example.com']) {
  const keys = await deriveTripKeys(generateSecret());
  const slug = `t-${crypto.randomUUID().slice(0, 8)}`;
  const trip = await makeTrip({
    address: `${slug}@${env.TRIP_DOMAIN}`,
    public_key: toBase64Url(keys.publicKey),
    allowed_senders: JSON.stringify(allowed),
  });
  return { trip, keys, address: trip.address };
}

function fakeMessage(rawText: string, to: string, auth: string | null = PASS) {
  const bytes = enc.encode(rawText);
  const headers = new Headers();
  const head = (rawText.split(/\r?\n\r?\n/)[0] ?? '').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':');
    headers.append(line.slice(0, i), line.slice(i + 1).trim());
  }
  if (auth) headers.append('authentication-results', auth);
  const setReject = vi.fn();
  const message = {
    from: 'bounce@example.com',
    to,
    headers,
    raw: new Response(bytes).body as ReadableStream<Uint8Array>,
    rawSize: bytes.byteLength,
    setReject,
  } as unknown as ForwardableEmailMessage;
  return { message, setReject, bytes };
}

async function run(message: ForwardableEmailMessage) {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as ExecutionContext;
  await handleEmail(message, env, ctx);
  await Promise.all(pending);
}

const blobCount = async (tripId: string) =>
  (await env.BLOBS.list({ prefix: `trips/${tripId}/` })).objects.length;

function spyRoutes() {
  const calls: { def: ParsedEmail[]; receipts: ParsedEmail[] } = { def: [], receipts: [] };
  const mk =
    (into: ParsedEmail[]): EmailRoute =>
    async ({ email }) =>
      void into.push(email);
  routes[''] = mk(calls.def);
  routes['receipts'] = mk(calls.receipts);
  return calls;
}

describe('email handler', () => {
  test('unknown address and wrong domain are rejected, nothing written', async () => {
    const calls = spyRoutes();
    for (const to of [`nobody-abc123@${env.TRIP_DOMAIN}`, 'x@other.example']) {
      const m = fakeMessage(plain, to);
      await run(m.message);
      expect(m.setReject).toHaveBeenCalledWith('unknown address');
    }
    expect(calls.def.length + calls.receipts.length).toBe(0);
  });

  test('sender not on the allowlist is dropped silently', async () => {
    const t = await setup(['bob@example.com']);
    const calls = spyRoutes();
    const m = fakeMessage(plain, t.address);
    await run(m.message);
    expect(m.setReject).not.toHaveBeenCalled();
    expect(await blobCount(t.trip.id)).toBe(0);
    expect(calls.def.length).toBe(0);
  });

  test('allowed sender without passing authentication is dropped', async () => {
    const t = await setup();
    const calls = spyRoutes();
    for (const auth of [null, 'mx.cloudflare.net; spf=fail; dkim=none; dmarc=fail']) {
      await run(fakeMessage(plain, t.address, auth).message);
    }
    expect(await blobCount(t.trip.id)).toBe(0);
    expect(calls.def.length).toBe(0);
  });

  test('allowed sender: one sealed blob opening to the original bytes, route gets the parsed email', async () => {
    const t = await setup();
    const calls = spyRoutes();
    const m = fakeMessage(pdf, t.address);
    await run(m.message);
    const list = await env.BLOBS.list({ prefix: `trips/${t.trip.id}/` });
    expect(list.objects.length).toBe(1);
    const sealed = new Uint8Array(
      (await (await env.BLOBS.get(list.objects[0]?.key ?? ''))?.arrayBuffer()) ??
        new ArrayBuffer(0),
    );
    expect(await open(t.keys.privateKey, sealed)).toEqual(m.bytes);

    expect(calls.def.length).toBe(1);
    const e = calls.def[0] as ParsedEmail;
    expect(e.from).toBe('alice@example.com');
    expect(e.suffix).toBe('');
    expect(e.subject).toBe('Ticket');
    expect(e.text).toContain('Ticket attached.');
    expect(e.attachments.length).toBe(1);
    const att = e.attachments[0] as ParsedEmail['attachments'][number];
    expect(att.filename).toBe('ticket.pdf');
    expect(att.mime).toBe('application/pdf');
    expect(new TextDecoder().decode(att.bytes)).toBe('%PDF-1.4\n%%EOF\n');
    expect(e.sourceAttachment).toEqual({
      id: list.objects[0]?.key.split('/').pop(),
      filename: 'Ticket.eml',
      mime: 'message/rfc822',
      size: m.bytes.byteLength,
      kind: 'source-email',
    });
  });

  test('plain, html and forwarded fixtures parse', async () => {
    const t = await setup();
    const calls = spyRoutes();
    for (const f of [plain, html, forwarded]) await run(fakeMessage(f, t.address).message);
    const [a, b, c] = calls.def as [ParsedEmail, ParsedEmail, ParsedEmail];
    expect(a.text).toContain('ABC123');
    expect(b.html).toContain('XY12');
    expect(c.from).toBe('alice@example.com');
    expect(c.text).toContain('Forwarded message');
    expect(await blobCount(t.trip.id)).toBe(3);
  });

  test('+receipts and +RECEIPTS select the receipts route; unknown suffix falls back', async () => {
    const t = await setup();
    const calls = spyRoutes();
    const [local = '', domain = ''] = t.address.split('@');
    await run(fakeMessage(plain, `${local}+receipts@${domain}`).message);
    await run(fakeMessage(plain, `${local.toUpperCase()}+RECEIPTS@${domain}`).message);
    await run(fakeMessage(plain, `${local}+whatever@${domain}`).message);
    expect(calls.receipts.length).toBe(2);
    expect(calls.receipts[1]?.suffix).toBe('receipts');
    expect(calls.def.length).toBe(1);
  });

  test('a throwing route does not fail the handler, and the raw email is already stored', async () => {
    const t = await setup();
    routes[''] = async () => {
      throw new Error('boom secret subject');
    };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await run(fakeMessage(plain, t.address).message);
    expect(await blobCount(t.trip.id)).toBe(1);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0])).not.toContain('secret');
  });
});

describe('spoofing and size', () => {
  const spoofs = [
    '"<alice@example.com>" <evil@evil.com>',
    'evil@evil.com (<alice@example.com>)',
    'evil@evil.com, alice@example.com',
  ];
  test.each(spoofs)('spoofed From %s is dropped', async (from) => {
    const t = await setup();
    const calls = spyRoutes();
    const auth = 'mx.cloudflare.net; dmarc=pass header.from=evil.com';
    await run(fakeMessage(plain.replace(/^From: .*$/m, `From: ${from}`), t.address, auth).message);
    expect(await blobCount(t.trip.id)).toBe(0);
    expect(calls.def.length).toBe(0);
  });

  test('two From headers are dropped', async () => {
    const t = await setup();
    const m = fakeMessage(plain, t.address);
    m.message.headers.append('from', 'evil@evil.com');
    await run(m.message);
    expect(await blobCount(t.trip.id)).toBe(0);
  });

  test('oversized message is rejected and nothing is written', async () => {
    const t = await setup();
    const calls = spyRoutes();
    const m = fakeMessage(plain, t.address);
    Object.defineProperty(m.message, 'rawSize', { value: 25 * 1024 * 1024 - 60 });
    await run(m.message);
    expect(m.setReject).toHaveBeenCalledWith('message too large');
    expect(await blobCount(t.trip.id)).toBe(0);
    expect(calls.def.length).toBe(0);
  });
});

describe('helpers', () => {
  test('splitRecipient', () => {
    expect(splitRecipient('Foo-ABC123+Receipts+x@Trips.Example.com')).toEqual({
      address: 'foo-abc123@trips.example.com',
      suffix: 'receipts+x',
      domain: 'trips.example.com',
    });
    expect(splitRecipient('nobody')).toBeNull();
  });

  test('senderAddress', () => {
    expect(senderAddress('Alice <Alice@Example.com>')).toBe('alice@example.com');
    expect(senderAddress('bob@example.com')).toBe('bob@example.com');
    expect(senderAddress('garbage')).toBeNull();
    expect(senderAddress(null)).toBeNull();
  });

  test('senderAddress fails closed on spoofing tricks', () => {
    expect(senderAddress('"<alice@allowed.com>" <evil@evil.com>')).toBe('evil@evil.com');
    expect(senderAddress('evil@evil.com (<alice@allowed.com>)')).toBe('evil@evil.com');
    expect(senderAddress('a@example.com, b@example.com')).toBeNull();
    expect(senderAddress('team: a@example.com, b@example.com;')).toBeNull();
    expect(senderAddress('Bob@Example.COM.')).toBe('bob@example.com');
  });

  test('passesAuth binds the pass to the From domain, strictly', () => {
    const f = 'a@example.com';
    expect(passesAuth(PASS, f)).toBe(true);
    expect(passesAuth('mx.cloudflare.net; dmarc=pass header.from=Example.com', f)).toBe(true);
    expect(passesAuth('mx.cloudflare.net; dmarc=pass', f)).toBe(false);
    expect(passesAuth('mx.cloudflare.net; dmarc=pass header.from=evil.com', f)).toBe(false);
    expect(passesAuth('mx.cloudflare.net; spf=pass smtp.mailfrom=bounces.example.com', f)).toBe(
      false,
    );
    expect(passesAuth('mx.cloudflare.net; spf=pass smtp.mailfrom=bob@example.com', f)).toBe(true);
    expect(passesAuth('mx.cloudflare.net; dkim=pass header.d=evil.com', f)).toBe(false);
    expect(passesAuth('mx.cloudflare.net; dkim=pass header.d=example.com', f)).toBe(true);
    expect(passesAuth('mx.cloudflare.net; spf=pass', f)).toBe(false);
    expect(passesAuth('mx.cloudflare.net; spf=fail smtp.mailfrom=example.com', f)).toBe(false);
    expect(passesAuth(null, f)).toBe(false);
  });

  test('sender-supplied Authentication-Results cannot vouch', () => {
    const f = 'a@example.com';
    expect(passesAuth('evil.example; dmarc=pass header.from=example.com', f)).toBe(false);
    expect(
      passesAuth(
        'mx.cloudflare.net; dmarc=fail, evil.example; dmarc=pass header.from=example.com',
        f,
      ),
    ).toBe(false);
  });
});
