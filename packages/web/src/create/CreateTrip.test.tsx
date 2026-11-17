import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { decodeSecret, deriveTripKeys, hashAccessToken, toBase64Url } from '@planfully/shared';
import { CreateTrip, parseSenders, tripEmails } from './CreateTrip';

const ADMIN = 'admin-secret-XYZ-123';
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fill() {
  render(
    <MemoryRouter>
      <CreateTrip />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Trip name'), { target: { value: 'Japan' } });
  fireEvent.change(screen.getByLabelText('Traveller 1 name'), { target: { value: 'Ann' } });
  fireEvent.change(screen.getByLabelText('Traveller 1 aliases'), {
    target: { value: 'A, Annie' },
  });
  fireEvent.change(screen.getByLabelText(/Allowed senders/), {
    target: { value: 'A@x.com, b@x.com' },
  });
  fireEvent.change(screen.getByLabelText(/Admin secret/), { target: { value: ADMIN } });
  fireEvent.click(screen.getByRole('button', { name: 'Create trip' }));
}

test('parseSenders splits, lowercases, dedupes', () => {
  expect(parseSenders('A@x.com, a@x.com\nb@x.com')).toEqual(['a@x.com', 'b@x.com']);
});

test('tripEmails handles full and bare addresses', () => {
  const want = { email: 'a-1@t.test', receipts: 'a-1+receipts@t.test' };
  expect(tripEmails('a-1@t.test', 't.test')).toEqual(want);
  expect(tripEmails('a-1', 't.test')).toEqual(want);
});

test('creates a trip; no request leaks the trip secret or puts the admin secret in URL/body', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ id: 'trip1', address: 'abc@trips.test', domain: 'trips.test' }), {
      status: 201,
    }),
  );
  fill();
  const urlEl = await screen.findByTestId('trip-url');
  const tripUrl = urlEl.textContent ?? '';
  const secret = tripUrl.split('#')[1] ?? '';
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(tripUrl).toContain('/t/trip1#');
  expect(screen.getByText('abc@trips.test')).toBeTruthy();
  expect(screen.getByText(/cannot be recovered/)).toBeTruthy();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  for (const [url, init] of fetchMock.mock.calls as [string, RequestInit][]) {
    expect(url).not.toContain(ADMIN);
    expect(url).not.toContain(secret);
    expect(url).not.toContain('#');
    expect(String(init.body)).not.toContain(ADMIN);
    expect(String(init.body)).not.toContain(secret);
    expect(JSON.stringify(init.headers)).not.toContain(secret);
  }
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ADMIN}`);
  const body = JSON.parse(String(init.body)) as {
    accessTokenHash: string;
    publicKey: string;
    roster: { id: string; name: string; aliases: string[] }[];
    allowedSenders: string[];
  };
  expect(body.accessTokenHash).toMatch(/^[0-9a-f]{64}$/);
  const keys = await deriveTripKeys(decodeSecret(secret));
  expect(body.accessTokenHash).toBe(await hashAccessToken(keys.accessToken));
  expect(body.publicKey).toBe(toBase64Url(keys.publicKey));
  expect(body.roster[0]).toMatchObject({ name: 'Ann', aliases: ['A', 'Annie'] });
  expect(body.roster[0]?.id).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(body.allowedSenders).toEqual(['a@x.com', 'b@x.com']);
});

test('401 shows a readable error', async () => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
  );
  fill();
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toMatch(/admin secret is wrong/),
  );
});

test('network failure shows a readable error', async () => {
  fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  fill();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Could not reach/));
});

test('aliases without a name is a validation error and sends nothing', async () => {
  render(
    <MemoryRouter>
      <CreateTrip />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Trip name'), { target: { value: 'T' } });
  fireEvent.change(screen.getByLabelText('Traveller 1 aliases'), { target: { value: 'Al' } });
  fireEvent.change(screen.getByLabelText(/Admin secret/), { target: { value: ADMIN } });
  fireEvent.click(screen.getByRole('button', { name: 'Create trip' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/name required/));
  expect(fetchMock).not.toHaveBeenCalled();
});

test('over-long trip name is rejected client-side', async () => {
  render(
    <MemoryRouter>
      <CreateTrip />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Trip name'), { target: { value: 'x'.repeat(201) } });
  fireEvent.change(screen.getByLabelText(/Admin secret/), { target: { value: ADMIN } });
  fireEvent.click(screen.getByRole('button', { name: 'Create trip' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/at most 200/));
  expect(fetchMock).not.toHaveBeenCalled();
});
