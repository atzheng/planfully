import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { useState } from 'react';
import type { Location } from '@planfully/shared';
import { PlaceSearch, SEARCH_DELAY_MS } from './PlaceSearch';

const geocode = vi.fn();
vi.mock('../lib/api', () => ({ geocode: (...a: unknown[]) => geocode(...a) }));
vi.mock('../trip/store', () => ({
  useTrip: (sel: (s: unknown) => unknown) => sel({ tripId: 't1', keys: { accessToken: 'tok' } }),
}));

const CDG: Location = { name: 'Louvre', address: 'Rue de Rivoli, Paris', lat: 48.86, lng: 2.33, placeId: 'p1' };

function Harness({ onPick }: { onPick: (p: Location) => void }) {
  const [v, setV] = useState('');
  return (
    <PlaceSearch
      id="x"
      value={v}
      onChange={setV}
      onPick={(p) => {
        setV(p.name ?? '');
        onPick(p);
      }}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  geocode.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const type = async (text: string) => {
  fireEvent.change(screen.getByRole('combobox'), { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS + 10);
  });
};

describe('PlaceSearch', () => {
  test('debounces, then lists results and picking returns the whole place', async () => {
    geocode.mockResolvedValue({ results: [CDG] });
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'lou' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'louvre' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS + 10);
    });
    expect(geocode).toHaveBeenCalledTimes(1);
    expect(geocode).toHaveBeenCalledWith({ tripId: 't1', accessToken: 'tok' }, 'louvre');
    fireEvent.mouseDown(screen.getByRole('option', { name: /Louvre/ }));
    expect(onPick).toHaveBeenCalledWith(CDG);
    // Picking does not search again for the filled-in name.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS + 10);
    });
    expect(geocode).toHaveBeenCalledTimes(1);
  });

  test('no results shows a note and keeps the text', async () => {
    geocode.mockResolvedValue({ results: [] });
    render(<Harness onPick={() => {}} />);
    await type('nowhere');
    expect(screen.getByRole('status').textContent).toContain('No results');
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('nowhere');
  });

  test('a failed lookup degrades to no results', async () => {
    geocode.mockRejectedValue(new Error('offline'));
    render(<Harness onPick={() => {}} />);
    await type('nowhere');
    expect(screen.getByRole('status').textContent).toContain('No results');
  });

  test('short text is not searched', async () => {
    render(<Harness onPick={() => {}} />);
    await type('ab');
    expect(geocode).not.toHaveBeenCalled();
  });
});
