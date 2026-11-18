import { afterEach, describe, expect, test, vi } from 'vitest';
import { parseEmail } from './parseEmail';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fakeWorker() {
  const w = {
    terminate: vi.fn(),
    postMessage: vi.fn(),
    onmessage: null as ((e: unknown) => void) | null,
    onerror: null as (() => void) | null,
    onmessageerror: null as (() => void) | null,
  };
  vi.stubGlobal('Worker', function () {
    return w;
  });
  return w;
}

describe('parseEmail worker handling', () => {
  test('times out and terminates a hung worker', async () => {
    vi.useFakeTimers();
    const w = fakeWorker();
    const p = parseEmail(new ArrayBuffer(8), 1000);
    const assertion = expect(p.promise).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(w.terminate).toHaveBeenCalled();
  });
  test('messageerror rejects', async () => {
    const w = fakeWorker();
    const p = parseEmail(new ArrayBuffer(8));
    w.onmessageerror?.();
    await expect(p.promise).rejects.toThrow();
    expect(w.terminate).toHaveBeenCalled();
  });
  test('resolves with the parsed email', async () => {
    const w = fakeWorker();
    const p = parseEmail(new ArrayBuffer(8));
    w.onmessage?.({ data: { id: 0, email: { attachments: [] } } });
    await expect(p.promise).resolves.toEqual({ attachments: [] });
  });
});
