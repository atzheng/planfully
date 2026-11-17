import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  deriveTripKeys,
  encodeSecret,
  generateSecret,
  sealJson,
  toBase64,
} from '@planfully/shared';
import { TripProvider, useTrip } from './store';

const META = (name: string) => ({
  id: 't1',
  name,
  address: 'a@b.c',
  domain: 'b.c',
  publicKey: 'x',
  roster: [],
  allowedSenders: [],
  createdAt: '2026-01-01T00:00:00.000Z',
});

const secretA = generateSecret();
const secretB = generateSecret();
let fetchMock: ReturnType<typeof vi.fn>;
let tokenA = '';
let tokenToName: Map<string, string>;

type Init = { headers: Record<string, string> };

// Serves trip A or B depending on which access token is presented.
beforeEach(async () => {
  tokenA = (await deriveTripKeys(secretA)).accessToken;
  tokenToName = new Map([
    [tokenA, 'Trip A'],
    [(await deriveTripKeys(secretB)).accessToken, 'Trip B'],
  ]);
  fetchMock = vi.fn(async (url: string, init: Init) => {
    const name = tokenToName.get(init.headers['Authorization']?.replace('Bearer ', '') ?? '');
    if (!name) return new Response('{"error":"no"}', { status: 401 });
    if (url.includes('/records')) {
      const keys = await deriveTripKeys(name === 'Trip A' ? secretA : secretB);
      const body = {
        kind: 'put',
        event: {
          id: 'e1',
          name: 'Dinner',
          type: 'activity',
          attachments: [],
          participants: [],
          status: 'confirmed',
          source: 'manual',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      };
      const ciphertext = toBase64(await sealJson(keys.publicKey, body));
      return new Response(
        JSON.stringify({
          records: [{ seq: 1, dedupe: null, createdAt: '2026-01-01T00:00:00.000Z', ciphertext }],
          latestSeq: 1,
          more: false,
        }),
      );
    }
    return new Response(JSON.stringify(META(name)));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

function Probe() {
  const name = useTrip((s) => s.meta?.name);
  const status = useTrip((s) => s.status);
  const n = useTrip((s) => s.events.length);
  return <p data-testid="p">{`${status}|${name ?? ''}|${n}`}</p>;
}

const probe = () => screen.getByTestId('p').textContent;

describe('TripProvider', () => {
  test('StrictMode (start, stop, start) still loads the trip', async () => {
    window.location.hash = '#' + encodeSecret(secretA);
    render(
      <StrictMode>
        <TripProvider tripId="t1">
          <Probe />
        </TripProvider>
      </StrictMode>,
    );
    await vi.waitFor(() => expect(probe()).toBe('ready|Trip A|1'));
  });

  test('hashchange A -> B -> removed -> A; the replaced store makes no further requests', async () => {
    window.location.hash = '#' + encodeSecret(secretA);
    render(
      <TripProvider tripId="t1">
        <Probe />
      </TripProvider>,
    );
    await vi.waitFor(() => expect(probe()).toBe('ready|Trip A|1'));

    const change = async (hash: string) => {
      await act(async () => {
        window.location.hash = hash;
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        await new Promise((r) => setTimeout(r, 30));
      });
    };

    await change('#' + encodeSecret(secretB));
    await vi.waitFor(() => expect(probe()).toBe('ready|Trip B|1'));

    // Removal keeps B; no requests at all, and A's old store must not wake up.
    fetchMock.mockClear();
    await change('');
    await new Promise((r) => setTimeout(r, 50));
    expect(probe()).toBe('ready|Trip B|1');
    expect(fetchMock).not.toHaveBeenCalled();

    // Back to A: replaced again; B's store (now stopped) makes no requests.
    await change('#' + encodeSecret(secretA));
    await vi.waitFor(() => expect(probe()).toBe('ready|Trip A|1'));
    await new Promise((r) => setTimeout(r, 50));
    const tokens = fetchMock.mock.calls.map((c) => (c[1] as Init).headers['Authorization']);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((t) => t === `Bearer ${tokenA}`)).toBe(true);
  });
});
