import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  deriveTripKeys,
  encodeSecret,
  fromBase64,
  generateSecret,
  openJson,
  sealJson,
  toBase64,
} from '@planfully/shared';
import { createTripStore, TripProvider } from '../trip/store';
import { EventSheet } from './EventSheet';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function setup(opts: { failPost?: boolean; event?: Record<string, unknown> } = {}) {
  const secret = generateSecret();
  const keys = await deriveTripKeys(secret);
  const event = {
    id: 'e1',
    name: 'Dinner',
    type: 'dining',
    start: { local: '2026-07-14T20:00', tz: 'Europe/Lisbon' },
    end: { local: '2026-07-14T22:00', tz: 'Europe/Lisbon' },
    attachments: [],
    participants: [],
    status: 'confirmed',
    source: 'email',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...opts.event,
  };
  const ciphertext = toBase64(await sealJson(keys.publicKey, { kind: 'put', event }));
  const api = {
    getTrip: async () => ({
      id: 't1',
      name: 'T',
      address: 'a@b.c',
      domain: 'b.c',
      publicKey: '',
      roster: [{ id: 'r1', name: 'Ana', aliases: [] }],
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
  const posted: unknown[] = [];
  let seq = 1;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      if (opts.failPost) return new Response('nope', { status: 400 });
      const { ciphertext: c } = JSON.parse(init.body) as { ciphertext: string };
      posted.push(await openJson(keys.privateKey, fromBase64(c)));
      return new Response(JSON.stringify({ seq: ++seq }), { status: 200 });
    }),
  );
  const loc = { current: '' };
  function Probe() {
    loc.current = useLocation().search;
    return null;
  }
  render(
    <MemoryRouter initialEntries={['/t/t1?e=e1']}>
      <TripProvider tripId="t1" store={store}>
        <EventSheet />
        <Probe />
      </TripProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: String(event.name).trim() });
  return { posted, loc, store };
}

const input = (label: string, i = 0) => screen.getAllByLabelText(label)[i] as HTMLInputElement;

describe('edit and delete', () => {
  test('editing a time sends a patch with only that field', async () => {
    const { posted } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(input('Start time'), { target: { value: '21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      kind: 'patch',
      target: 'e1',
      fields: { start: { local: '2026-07-14T21:00', tz: 'Europe/Lisbon' } },
    });
    await screen.findByRole('button', { name: 'Edit' });
    expect(screen.getAllByText(/21:00/).length).toBeGreaterThan(0);
  });

  test('invalid input shows field errors and sends nothing', async () => {
    const { posted } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(input('Name'), { target: { value: '' } });
    fireEvent.change(input('End date'), { target: { value: '2026-07-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a name')).toBeTruthy();
    expect(screen.getByText('End is before the start')).toBeTruthy();
    expect(posted).toHaveLength(0);
  });

  test('clearing confirmation sends null and the event loses it', async () => {
    const { posted } = await setup({ event: { confirmation: 'ABC123' } });
    expect(screen.getAllByText(/ABC123/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(input('Confirmation'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ kind: 'patch', target: 'e1', fields: { confirmation: null } });
    await screen.findByRole('button', { name: 'Edit' });
    expect(screen.queryByText(/ABC123/)).toBeNull();
  });

  test('a refused save keeps the form open and shows a dismissible error', async () => {
    const { store } = await setup({ failPost: true });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(input('Name'), { target: { value: 'Supper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Could not save/)).toBeTruthy();
    // lastError is set before the form's submit promise settles, so the button reads
    // "Saving..." for a moment: wait for it to come back instead of asserting synchronously.
    expect(await screen.findByRole('button', { name: 'Save' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(store.getState().lastError).toBeNull());
  });

  test('delete asks for confirmation, sends a delete and closes the sheet', async () => {
    const { posted, loc } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(posted).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(loc.current).toBe(''));
    await waitFor(() => expect(posted).toEqual([{ kind: 'delete', target: 'e1' }]));
  });

  test('keep cancels the delete', async () => {
    const { posted } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(posted).toHaveLength(0);
  });

  test('saving with no edits sends nothing, even with untrimmed text and coordinates', async () => {
    const { posted } = await setup({
      event: {
        name: 'Dinner ',
        confirmation: ' ABC ',
        notes: 'note ',
        location: { name: ' Inn', address: 'Rua 1 ', lat: 38.7, lng: -9.1, placeId: 'p' },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByRole('button', { name: 'Edit' });
    expect(posted).toHaveLength(0);
  });

  test('a sync while the form is open does not leak stale values into the patch', async () => {
    const { posted, store } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    act(() => {
      store.getState().append([
        {
          seq: 50,
          dedupe: null,
          createdAt: '2026-07-02T00:00:00.000Z',
          body: { kind: 'patch', target: 'e1', fields: { notes: 'changed elsewhere' } },
        },
      ] as never);
    });
    fireEvent.change(input('Start time'), { target: { value: '21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0] as { fields: object }).fields).toEqual({
      start: { local: '2026-07-14T21:00', tz: 'Europe/Lisbon' },
    });
  });
});
