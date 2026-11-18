import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppBar } from './AppBar';

const discard = vi.fn();
let state: Record<string, unknown> = {};
vi.mock('../trip/store', () => ({
  TripProvider: ({ children }: { children: ReactNode }) => children,
  useTripStore: () => ({ getState: () => ({}) }),
  useTrip: (sel?: (s: unknown) => unknown) => (sel ? sel(state) : state),
}));
vi.mock('../offline/queue', () => ({ getTripQueue: () => ({ discard }) }));
vi.mock('../event/UploadButtons', () => ({ AddReceiptAction: () => null }));

const base = { status: 'ready', error: null, meta: null, events: [], pending: 2 };
afterEach(() => {
  cleanup();
  discard.mockReset();
});
const mount = () =>
  render(
    <MemoryRouter initialEntries={['/t/x#abc']}>
      <AppBar view="timeline" setView={() => {}} />
    </MemoryRouter>,
  );

describe('sync chip', () => {
  test('hidden unless stalled', () => {
    state = { ...base, queueStalled: false, queueAccessLost: false };
    mount();
    expect(screen.queryByTestId('sync-waiting')).toBeNull();
  });
  test('waiting count, no discard', () => {
    state = { ...base, queueStalled: true, queueAccessLost: false };
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    mount();
    const chip = screen.getByTestId('sync-waiting');
    expect(chip.getAttribute('aria-label')).toBe('2 changes waiting to sync');
    fireEvent.click(chip);
    expect(discard).not.toHaveBeenCalled();
  });
  test('access lost: confirm then discard; cancel keeps', () => {
    state = { ...base, queueStalled: true, queueAccessLost: true };
    const conf = vi.fn(() => false);
    vi.stubGlobal('confirm', conf);
    mount();
    const chip = screen.getByTestId('sync-waiting');
    expect(chip.getAttribute('aria-label')).toMatch(/no longer has access/);
    fireEvent.click(chip);
    expect(discard).not.toHaveBeenCalled();
    conf.mockReturnValue(true);
    fireEvent.click(chip);
    expect(discard).toHaveBeenCalledTimes(1);
  });
});
