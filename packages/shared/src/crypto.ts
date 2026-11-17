import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const SEAL_VERSION = 0x01;
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

// WebCrypto's BufferSource typing rejects Uint8Array<ArrayBufferLike>; the runtime accepts it.
const buf = (b: Uint8Array): BufferSource => b as Uint8Array<ArrayBuffer>;

export function toBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toBase64Url(b: Uint8Array): string {
  return toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export function generateSecret(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export function encodeSecret(s: Uint8Array): string {
  return toBase64Url(s);
}

export function decodeSecret(s: string): Uint8Array {
  const out = fromBase64Url(s);
  if (out.length !== 32) throw new Error('invalid secret length');
  return out;
}

export async function deriveTripKeys(
  secret: Uint8Array,
): Promise<{ privateKey: Uint8Array; publicKey: Uint8Array; accessToken: string }> {
  const privateKey = hkdf(sha256, secret, undefined, enc.encode('planfully/x25519/v1'), 32);
  const publicKey = x25519.getPublicKey(privateKey);
  const accessToken = toBase64Url(
    hkdf(sha256, secret, undefined, enc.encode('planfully/access/v1'), 32),
  );
  return { privateKey, publicKey, accessToken };
}

export async function hashAccessToken(token: string): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest('SHA-256', buf(enc.encode(token)))));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function aesKey(
  shared: Uint8Array,
  ephemeralPublic: Uint8Array,
  recipientPublic: Uint8Array,
  usage: KeyUsage,
): Promise<CryptoKey> {
  const raw = hkdf(
    sha256,
    shared,
    concat(ephemeralPublic, recipientPublic),
    enc.encode('planfully/seal/v1'),
    32,
  );
  return subtle().importKey('raw', buf(raw), 'AES-GCM', false, [usage]);
}

/**
 * Seal with caller-supplied ephemeral private key and nonce. Internal and test-only:
 * production code must use `seal`, which draws both from the CSPRNG. Reusing either
 * value across messages breaks confidentiality.
 */
export async function sealWithEphemeral(
  publicKey: Uint8Array,
  plaintext: Uint8Array,
  ephemeralPrivate: Uint8Array,
  nonce: Uint8Array,
): Promise<Uint8Array> {
  const ephemeralPublic = x25519.getPublicKey(ephemeralPrivate);
  const key = await aesKey(
    x25519.getSharedSecret(ephemeralPrivate, publicKey),
    ephemeralPublic,
    publicKey,
    'encrypt',
  );
  const ct = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: buf(nonce) }, key, buf(plaintext)),
  );
  return concat(new Uint8Array([SEAL_VERSION]), ephemeralPublic, nonce, ct);
}

export function seal(publicKey: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  return sealWithEphemeral(
    publicKey,
    plaintext,
    x25519.utils.randomSecretKey(),
    globalThis.crypto.getRandomValues(new Uint8Array(12)),
  );
}

export async function open(privateKey: Uint8Array, sealed: Uint8Array): Promise<Uint8Array> {
  // version + ephemeral pub + nonce + GCM tag
  if (sealed.length < 1 + 32 + 12 + 16) throw new Error('sealed data too short');
  if (sealed[0] !== SEAL_VERSION) throw new Error(`unsupported sealed version ${sealed[0]}`);
  const ephemeralPublic = sealed.subarray(1, 33);
  const nonce = sealed.subarray(33, 45);
  const ct = sealed.subarray(45);
  const recipientPublic = x25519.getPublicKey(privateKey);
  const key = await aesKey(
    x25519.getSharedSecret(privateKey, ephemeralPublic),
    ephemeralPublic,
    recipientPublic,
    'decrypt',
  );
  // AES-GCM rejects on tag mismatch (tamper or wrong key).
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(nonce) }, key, buf(ct)));
}

export function sealJson(publicKey: Uint8Array, value: unknown): Promise<Uint8Array> {
  return seal(publicKey, enc.encode(JSON.stringify(value)));
}

export async function openJson<T>(privateKey: Uint8Array, sealed: Uint8Array): Promise<T> {
  return JSON.parse(dec.decode(await open(privateKey, sealed))) as T;
}

export async function dedupeTag(
  dedupeKey: Uint8Array,
  type: string,
  confirmation: string,
): Promise<string> {
  const normalised = confirmation.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const key = await subtle().importKey(
    'raw',
    buf(dedupeKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return toHex(
    new Uint8Array(await subtle().sign('HMAC', key, buf(enc.encode(`${type}\n${normalised}`)))),
  );
}
