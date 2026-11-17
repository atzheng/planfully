import { describe, expect, it } from 'vitest';
import {
  dedupeTag,
  deriveTripKeys,
  encodeSecret,
  hashAccessToken,
  open,
  sealWithEphemeral,
} from '@planfully/shared';
import vectors from '../../shared/test/vectors.json';

const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// Same vectors as packages/shared, run inside the Workers runtime.
describe('shared crypto vectors in workerd', () => {
  it('derives keys, token and hash', async () => {
    const k = await deriveTripKeys(unhex(vectors.secretHex));
    expect(hex(k.publicKey)).toBe(vectors.publicKeyHex);
    expect(k.accessToken).toBe(vectors.accessToken);
    expect(await hashAccessToken(k.accessToken)).toBe(vectors.accessTokenHash);
    expect(encodeSecret(unhex(vectors.secretHex))).toBe(vectors.secretEncoded);
  });

  it('computes the dedupe tag', async () => {
    const d = vectors.dedupe;
    expect(await dedupeTag(unhex(d.keyHex), d.type, d.confirmation)).toBe(d.tag);
  });

  it('reproduces and opens the sealed vector', async () => {
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
