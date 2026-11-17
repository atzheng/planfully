import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { TripMeta } from '@planfully/shared';

const META: TripMeta = {
  id: 't1',
  name: 'Japan',
  address: 'japan-abc123@trips.example.com',
  domain: 'trips.example.com',
  publicKey: 'x',
  roster: [
    { id: 'a', name: 'Ann', aliases: ['A'] },
    { id: 'b', name: 'Bo', aliases: [] },
  ],
  allowedSenders: ['ann@x.com'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const setMeta = vi.fn();
const state = {
  meta: META as TripMeta | null,
  status: 'ready',
  error: null,
  keys: { accessToken: 'tok' },
  events: [{ id: 'e1', participants: ['a'] }],
  setMeta,
};
vi.mock('../trip/store', () => ({
  useTrip: (sel: (s: typeof state) => unknown) => sel(state),
}));

import { Settings } from './Settings';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  setMeta.mockReset();
  fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const patch = JSON.parse(init.body) as Partial<TripMeta>;
    return new Response(JSON.stringify({ ...META, ...patch }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function addBtn(i: number): HTMLElement {
  const b = screen.getAllByRole('button', { name: 'Add' })[i];
  if (!b) throw new Error('no add button');
  return b;
}

function renderIt() {
  render(
    <MemoryRouter initialEntries={['/t/t1/settings']}>
      <Routes>
        <Route path="/t/:tripId/settings" element={<Settings />} />
      </Routes>
    </MemoryRouter>,
  );
}

test('copy buttons copy the trip and receipts addresses', async () => {
  renderIt();
  fireEvent.click(screen.getByRole('button', { name: 'Copy Trip address' }));
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('japan-abc123@trips.example.com'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Copy Receipts address' }));
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      'japan-abc123+receipts@trips.example.com',
    ),
  );
});

test('invalid sender is rejected and nothing is added', () => {
  renderIt();
  fireEvent.change(screen.getByLabelText('New allowed sender'), { target: { value: 'nope' } });
  fireEvent.click(addBtn(1));
  expect(screen.getByRole('alert').textContent).toMatch(/not a valid email/);
  expect(screen.getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
});

test('add member and sender, rename keeps id, save PATCHes and updates the store', async () => {
  renderIt();
  fireEvent.change(screen.getByLabelText('New traveller name'), { target: { value: 'Cy' } });
  fireEvent.click(addBtn(0));
  fireEvent.change(screen.getByLabelText('New allowed sender'), {
    target: { value: ' New@X.com ' },
  });
  fireEvent.click(addBtn(1));
  fireEvent.change(screen.getByLabelText('Name of Ann'), { target: { value: 'Anna' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(setMeta).toHaveBeenCalled());
  const [url, init] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
  expect(url).toBe('/api/trips/t1');
  expect(init.method).toBe('PATCH');
  const body = JSON.parse(init.body) as { roster: TripMeta['roster']; allowedSenders: string[] };
  expect(body.allowedSenders).toEqual(['ann@x.com', 'new@x.com']);
  expect(body.roster.map((m) => [m.id, m.name])).toEqual([
    ['a', 'Anna'],
    ['b', 'Bo'],
    [expect.any(String), 'Cy'],
  ]);
});

test('removing a referenced member asks for confirmation', () => {
  renderIt();
  fireEvent.click(screen.getByRole('button', { name: 'Remove Ann' }));
  expect(screen.getByRole('alert').textContent).toMatch(/1 event refers to Ann/);
  expect(screen.getByLabelText('Name of Ann')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Remove anyway' }));
  expect(screen.queryByLabelText('Name of Ann')).toBeNull();
  // Unreferenced member goes straight away.
  fireEvent.click(screen.getByRole('button', { name: 'Remove Bo' }));
  expect(screen.queryByLabelText('Name of Bo')).toBeNull();
});
