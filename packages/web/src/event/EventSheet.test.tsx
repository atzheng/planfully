import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  deriveTripKeys,
  encodeSecret,
  generateSecret,
  seal,
  sealJson,
  toBase64,
} from '@planfully/shared';
import { createTripStore, TripProvider } from '../trip/store';
import { EventSheet } from './EventSheet';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PDF = new Uint8Array([37, 80, 68, 70, 1, 2, 3]);

async function setup(search: string) {
  const secret = generateSecret();
  const keys = await deriveTripKeys(secret);
  const event = {
    id: 'e1',
    name: 'Dinner at Belcanto',
    type: 'dining',
    start: { local: '2026-07-14T20:00', tz: 'Europe/Lisbon' },
    end: { local: '2026-07-14T22:00', tz: 'Europe/Lisbon' },
    confirmation: 'ABC123',
    location: { name: 'Belcanto', lat: 38.7, lng: -9.1 },
    attachments: [
      { id: 'b1', filename: 'res.pdf', mime: 'application/pdf', size: 7, kind: 'file' },
      { id: 'b2', filename: 'mail.eml', mime: 'message/rfc822', size: 7, kind: 'source-email' },
    ],
    participants: [],
    status: 'cancelled',
    notes: 'Window table',
    source: 'email',
    needsReview: true,
    createdAt: '2026-07-01T00:00:00.000Z',
  };
  const ciphertext = toBase64(await sealJson(keys.publicKey, { kind: 'put', event }));
  const api = {
    getTrip: async () => ({
      id: 't1',
      name: 'T',
      address: 'a@b.c',
      domain: 'b.c',
      publicKey: '',
      roster: [],
      allowedSenders: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    getRecords: async () => ({
      records: [{ seq: 1, ciphertext, createdAt: '2026-07-01T00:00:00.000Z' }],
      latestSeq: 1,
      more: false,
    }),
  };
  const store = createTripStore({
    tripId: 't1',
    fragment: encodeSecret(secret),
    api: api as never,
  });
  const sealedPdf = await seal(keys.publicKey, PDF);
  const fetchMock = vi.fn(
    async () => new Response(sealedPdf as BlobPart, { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const location = { current: '' };
  function Probe() {
    location.current = useLocation().search;
    return null;
  }
  render(
    <MemoryRouter initialEntries={[`/t/t1${search}`]}>
      <TripProvider tripId="t1" store={store}>
        <EventSheet />
        <Probe />
      </TripProvider>
    </MemoryRouter>,
  );
  return { location, fetchMock };
}

describe('EventSheet', () => {
  test('renders every populated field', async () => {
    await setup('?e=e1');
    expect(await screen.findByRole('heading', { name: 'Dinner at Belcanto' })).toBeTruthy();
    expect(screen.getByText('dining')).toBeTruthy();
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(screen.getByText('Needs review')).toBeTruthy();
    expect(screen.getByText('2h')).toBeTruthy();
    expect(screen.getByText('ABC123')).toBeTruthy();
    expect(screen.getByText('Everyone')).toBeTruthy();
    expect(screen.getByText('Window table')).toBeTruthy();
    expect(screen.getByText('Original email')).toBeTruthy();
    const maps = screen.getByRole('link', { name: 'Open in Google Maps' });
    expect(maps.getAttribute('href')).toContain('38.7%2C-9.1');
  });

  test('unknown id shows not found', async () => {
    await setup('?e=nope');
    expect(await screen.findByRole('heading', { name: 'Event not found' })).toBeTruthy();
  });

  test('Escape and backdrop clear the query key', async () => {
    const { location } = await setup('?e=e1');
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(location.current).toBe(''));
    cleanup();
  });

  test('backdrop click closes', async () => {
    const { location } = await setup('?e=e1');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(dialog.parentElement as HTMLElement);
    await waitFor(() => expect(location.current).toBe(''));
  });

  test('attachment is fetched, decrypted and downloaded with its original bytes', async () => {
    const { fetchMock } = await setup('?e=e1');
    let blob: Blob | undefined;
    const create = vi.fn((b: Blob) => {
      blob = b;
      return 'blob:x';
    });
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const win = { location: { href: '' }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => win));
    fireEvent.click(await screen.findByRole('button', { name: 'res.pdf' }));
    await waitFor(() => expect(win.location.href).toBe('blob:x'));
    expect(fetchMock).toHaveBeenCalled();
    const firstCall = fetchMock.mock.calls[0] as unknown as [string];
    expect(firstCall[0]).toBe('/api/trips/t1/blobs/b1');
    expect(blob?.type).toBe('application/pdf');
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(PDF);
    cleanup(); // unmount revokes
    expect(revoke).toHaveBeenCalledWith('blob:x');
    await act(async () => {});
  });
});
