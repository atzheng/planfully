import { beforeEach, describe, expect, test, vi } from 'vitest';
import { deriveTripKeys, generateSecret, open } from '@planfully/shared';

const putBlob = vi.fn();
vi.mock('../lib/api', () => ({ putBlob: (...a: unknown[]) => putBlob(...a), getBlob: vi.fn() }));

import { FileTooLargeError, MAX_UPLOAD_BYTES, uploadAttachment } from './attachments';

let ctx: Awaited<ReturnType<typeof makeCtx>>;
async function makeCtx() {
  const k = await deriveTripKeys(generateSecret());
  return {
    tripId: 't1',
    accessToken: k.accessToken,
    privateKey: k.privateKey,
    publicKey: k.publicKey,
  };
}
beforeEach(async () => {
  putBlob.mockReset().mockResolvedValue(undefined);
  ctx = await makeCtx();
});

describe('uploadAttachment', () => {
  test('seals the bytes, PUTs a new blob and describes it', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const a = await uploadAttachment(
      new File([bytes], 'pass.pdf', { type: 'application/pdf' }),
      ctx,
    );
    expect(a).toMatchObject({
      kind: 'file',
      filename: 'pass.pdf',
      mime: 'application/pdf',
      size: 4,
    });
    const [auth, id, sealed] = putBlob.mock.calls[0] as [unknown, string, Uint8Array];
    expect(auth).toEqual({ tripId: 't1', accessToken: ctx.accessToken });
    expect(id).toBe(a.id);
    expect(Array.from(await open(ctx.privateKey, sealed))).toEqual([1, 2, 3, 250]);
  });

  test('unknown type falls back to octet-stream', async () => {
    const a = await uploadAttachment(new File(['x'], 'blob'), ctx);
    expect(a.mime).toBe('application/octet-stream');
  });

  test('refuses files over the limit before sealing or sending', async () => {
    const big = { name: 'big.bin', size: MAX_UPLOAD_BYTES + 1 } as File;
    await expect(uploadAttachment(big, ctx)).rejects.toBeInstanceOf(FileTooLargeError);
    expect(putBlob).not.toHaveBeenCalled();
  });
});
