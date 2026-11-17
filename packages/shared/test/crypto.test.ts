import { describe, expect, it } from 'vitest';
import vectors from './vectors.json';
import {
  dedupeTag,
  decodeSecret,
  deriveTripKeys,
  encodeSecret,
  fromBase64,
  fromBase64Url,
  generateSecret,
  hashAccessToken,
  open,
  openJson,
  seal,
  sealJson,
  sealWithEphemeral,
  toBase64,
  toBase64Url,
} from '../src/crypto';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const fill = (n: number, v: number) => new Uint8Array(n).fill(v);

const FIXED = {
  secret: fill(32, 7),
  dedupeKey: fill(32, 9),
  ephemeralPrivate: fill(32, 3),
  nonce: fill(12, 5),
  plaintext: new TextEncoder().encode('Flight AB123 departs 09:30'),
};

async function generate() {
  const k = await deriveTripKeys(FIXED.secret);
  const sealed = await sealWithEphemeral(
    k.publicKey,
    FIXED.plaintext,
    FIXED.ephemeralPrivate,
    FIXED.nonce,
  );
  return {
    secretHex: hex(FIXED.secret),
    secretEncoded: encodeSecret(FIXED.secret),
    publicKeyHex: hex(k.publicKey),
    accessToken: k.accessToken,
    accessTokenHash: await hashAccessToken(k.accessToken),
    dedupe: {
      keyHex: hex(FIXED.dedupeKey),
      type: 'flight',
      confirmation: 'ab-12 3',
      tag: await dedupeTag(FIXED.dedupeKey, 'flight', 'ab-12 3'),
    },
    seal: {
      ephemeralPrivateHex: hex(FIXED.ephemeralPrivate),
      nonceHex: hex(FIXED.nonce),
      plaintext: new TextDecoder().decode(FIXED.plaintext),
      sealedHex: hex(sealed),
    },
  };
}

// Regenerate test/vectors.json from this implementation with:
//   GEN_VECTORS=1 pnpm --filter @planfully/shared test  (prints the JSON; paste it into vectors.json)
it.runIf(!!(globalThis as { process?: { env: Record<string, string> } }).process?.env.GEN_VECTORS)(
  'prints vectors',
  async () => {
    throw new Error('VECTORS' + JSON.stringify(await generate(), null, 2));
  },
);

describe('vectors.json', () => {
  it('deriveTripKeys matches', async () => {
    const k = await deriveTripKeys(unhex(vectors.secretHex));
    expect(hex(k.publicKey)).toBe(vectors.publicKeyHex);
    expect(k.accessToken).toBe(vectors.accessToken);
    expect(await hashAccessToken(k.accessToken)).toBe(vectors.accessTokenHash);
    expect(encodeSecret(unhex(vectors.secretHex))).toBe(vectors.secretEncoded);
  });
  it('dedupeTag matches', async () => {
    const d = vectors.dedupe;
    expect(await dedupeTag(unhex(d.keyHex), d.type, d.confirmation)).toBe(d.tag);
  });
  it('sealed vector is reproducible and opens to the plaintext', async () => {
    const k = await deriveTripKeys(unhex(vectors.secretHex));
    const s = vectors.seal;
    const sealed = await sealWithEphemeral(
      k.publicKey,
      new TextEncoder().encode(s.plaintext),
      unhex(s.ephemeralPrivateHex),
      unhex(s.nonceHex),
    );
    expect(hex(sealed)).toBe(s.sealedHex);
    const opened = await open(k.privateKey, unhex(s.sealedHex));
    expect(new TextDecoder().decode(opened)).toBe(s.plaintext);
  });
});

describe('deriveTripKeys', () => {
  it('is deterministic and distinct per secret', async () => {
    const a = await deriveTripKeys(fill(32, 1));
    const b = await deriveTripKeys(fill(32, 1));
    const c = await deriveTripKeys(fill(32, 2));
    expect(a).toEqual(b);
    expect(c.accessToken).not.toBe(a.accessToken);
  });
});

describe('seal/open', () => {
  it.each([
    ['empty', 0],
    ['small', 100],
    ['5 MB', 5 * 1024 * 1024],
  ])('round-trips %s', async (_n, size) => {
    const { privateKey, publicKey } = await deriveTripKeys(generateSecret());
    const pt = new Uint8Array(size);
    for (let i = 0; i < size; i += 65536) {
      crypto.getRandomValues(pt.subarray(i, Math.min(i + 65536, size)));
    }
    const sealed = await seal(publicKey, pt);
    expect(sealed.length).toBe(size + 1 + 32 + 12 + 16);
    expect(sealed[0]).toBe(1);
    const back = await open(privateKey, sealed);
    expect(back.length).toBe(size);
    expect(back.every((v, i) => v === pt[i])).toBe(true); // toEqual is very slow on 5 MB arrays
  });

  it('is randomised', async () => {
    const { publicKey } = await deriveTripKeys(fill(32, 1));
    const pt = fill(10, 1);
    expect(await seal(publicKey, pt)).not.toEqual(await seal(publicKey, pt));
  });

  it('throws on a flipped byte anywhere', async () => {
    const { privateKey, publicKey } = await deriveTripKeys(fill(32, 1));
    const sealed = await seal(publicKey, fill(20, 4));
    for (const i of [1, 33, 45, sealed.length - 1]) {
      const bad = sealed.slice();
      bad[i] = (bad[i] ?? 0) ^ 1;
      await expect(open(privateKey, bad)).rejects.toThrow();
    }
  });

  it('throws on truncated input', async () => {
    const { privateKey, publicKey } = await deriveTripKeys(fill(32, 1));
    const sealed = await seal(publicKey, fill(20, 4));
    await expect(open(privateKey, sealed.slice(0, sealed.length - 1))).rejects.toThrow();
    await expect(open(privateKey, sealed.slice(0, 20))).rejects.toThrow();
    await expect(open(privateKey, new Uint8Array(0))).rejects.toThrow();
  });

  it('throws with the wrong key', async () => {
    const a = await deriveTripKeys(fill(32, 1));
    const b = await deriveTripKeys(fill(32, 2));
    await expect(open(b.privateKey, await seal(a.publicKey, fill(5, 1)))).rejects.toThrow();
  });

  it('throws on unknown version byte', async () => {
    const { privateKey, publicKey } = await deriveTripKeys(fill(32, 1));
    const sealed = await seal(publicKey, fill(5, 1));
    sealed[0] = 2;
    await expect(open(privateKey, sealed)).rejects.toThrow(/version/);
  });

  it('sealJson/openJson round-trip', async () => {
    const { privateKey, publicKey } = await deriveTripKeys(fill(32, 1));
    const v = { a: 1, b: ['x', null], c: 'é' };
    expect(await openJson(privateKey, await sealJson(publicKey, v))).toEqual(v);
  });
});

describe('dedupeTag', () => {
  it('normalises confirmation codes', async () => {
    const key = fill(32, 1);
    expect(await dedupeTag(key, 'flight', 'ab-12 3')).toBe(await dedupeTag(key, 'flight', 'AB123'));
    expect(await dedupeTag(key, 'flight', 'AB123')).not.toBe(
      await dedupeTag(key, 'hotel', 'AB123'),
    );
    expect(await dedupeTag(key, 'flight', 'AB123')).not.toBe(
      await dedupeTag(fill(32, 2), 'flight', 'AB123'),
    );
  });
});

describe('encoding', () => {
  it('encodeSecret/decodeSecret round-trip', () => {
    const s = generateSecret();
    const e = encodeSecret(s);
    expect(e).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(decodeSecret(e)).toEqual(s);
    expect(() => decodeSecret('abc')).toThrow();
  });
  it('base64 variants round-trip', () => {
    const b = Uint8Array.from([251, 255, 0, 62, 63, 1]);
    expect(fromBase64(toBase64(b))).toEqual(b);
    expect(fromBase64Url(toBase64Url(b))).toEqual(b);
    expect(toBase64Url(b)).not.toMatch(/[+/=]/);
  });
});
