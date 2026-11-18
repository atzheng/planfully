import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
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
import { MAX_EMAIL_BYTES } from './emailModel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HTML_EML = [
  'From: Hotel <h@example.com>',
  'To: Alex <a@example.com>',
  'Subject: Your booking',
  'Date: Tue, 05 May 2026 09:48:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Hi <a href="https://example.com">there</a></p><img src="https://t.example/p.gif"><script>x()</script>',
  '',
].join('\r\n');

const TEXT_EML = [
  'From: h@example.com',
  'Subject: Plain',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'See https://example.com/a for <b>details</b>.',
  '',
].join('\r\n');

async function setup(eml: string) {
  const secret = generateSecret();
  const keys = await deriveTripKeys(secret);
  const event = {
    id: 'e1',
    name: 'Dinner',
    type: 'dining',
    attachments: [
      {
        id: 'b2',
        filename: 'mail.eml',
        mime: 'message/rfc822',
        size: eml.length,
        kind: 'source-email',
      },
    ],
    participants: [],
    status: 'confirmed',
    source: 'email',
    needsReview: false,
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
  const sealed = await seal(keys.publicKey, new TextEncoder().encode(eml));
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(sealed as BlobPart, { status: 200 })),
  );
  render(
    <MemoryRouter initialEntries={['/t/t1?e=e1']}>
      <TripProvider tripId="t1" store={store}>
        <EventSheet />
      </TripProvider>
    </MemoryRouter>,
  );
}

describe('EmailViewer', () => {
  test('HTML email: headers, sandboxed iframe without scripts, CSP, remote images blocked', async () => {
    await setup(HTML_EML);
    fireEvent.click(await screen.findByTestId('view-email'));
    expect(await screen.findByText('Your booking')).toBeTruthy();
    expect(screen.getByText('Hotel <h@example.com>')).toBeTruthy();
    const frame = (await screen.findByTitle('Email body')) as HTMLIFrameElement;
    const sandbox = frame.getAttribute('sandbox') ?? '';
    expect(sandbox).not.toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    const doc = frame.getAttribute('srcdoc') ?? '';
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toMatch(/img-src[^"]*https:/);
    expect(doc).not.toContain('<script');
    fireEvent.click(screen.getByRole('button', { name: 'Load remote images' }));
    await waitFor(() =>
      expect((screen.getByTitle('Email body') as HTMLIFrameElement).getAttribute('srcdoc')).toMatch(
        /img-src data: blob: https:/,
      ),
    );
    // Back returns to the event details, where Download .eml is still offered.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('button', { name: 'Download .eml' })).toBeTruthy();
  });

  test('over the size cap: headers and a download offer, no body parsing', async () => {
    const big = TEXT_EML + 'x'.repeat(MAX_EMAIL_BYTES);
    await setup(big);
    fireEvent.click(await screen.findByTestId('view-email'));
    expect(await screen.findByText(/too large to view here/)).toBeTruthy();
    expect(screen.getByText('Plain')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download .eml' })).toBeTruthy();
    expect(document.querySelector('pre, iframe')).toBeNull();
  }, 30_000);

  test('text email: linkified, markup shown as text', async () => {
    await setup(TEXT_EML);
    fireEvent.click(await screen.findByTestId('view-email'));
    const link = await screen.findByRole('link', { name: 'https://example.com/a' });
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText(/<b>details<\/b>/)).toBeTruthy();
    expect(document.querySelector('pre b')).toBeNull();
  });
});

describe('openOrDownload', () => {
  test('opens a valid PDF synchronously in the click tick, downloads a fake one', async () => {
    const { openOrDownload } = await import('./EmailViewer');
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const base = {
      filename: 'a.pdf',
      mimeType: 'application/pdf',
      disposition: 'attachment' as const,
    };
    openOrDownload({ ...base, content: new TextEncoder().encode('%PDF-1.7 x') });
    expect(open).toHaveBeenCalledTimes(1); // no await before it
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    openOrDownload({ ...base, content: new TextEncoder().encode('<script>') });
    expect(open).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});
