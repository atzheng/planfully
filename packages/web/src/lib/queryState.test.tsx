import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '../App';
import {
  booleanCodec,
  dateCodec,
  enumCodec,
  nextSearch,
  numberCodec,
  stringCodec,
  stringListCodec,
  useQueryState,
} from './queryState';

// The shell's view switching is under test here, not loading; stub the trip store as ready.
vi.mock('../trip/store', () => ({
  TripProvider: ({ children }: { children: ReactNode }) => children,
  useTrip: (sel?: (s: unknown) => unknown) => {
    const state = { status: 'ready', error: null, meta: null, events: [] };
    return sel ? sel(state) : state;
  },
}));

vi.mock('../event/UploadButtons', () => ({ AddReceiptButton: () => null }));

afterEach(cleanup);

describe('codecs', () => {
  test('string', () => {
    expect(stringCodec.parse('a b')).toBe('a b');
    expect(stringCodec.serialize('a b')).toBe('a b');
  });
  test('number', () => {
    expect(numberCodec.parse('2.5')).toBe(2.5);
    expect(numberCodec.parse('abc')).toBeUndefined();
    expect(numberCodec.parse('')).toBeUndefined();
    expect(numberCodec.serialize(3)).toBe('3');
  });
  test('boolean', () => {
    expect(booleanCodec.parse('1')).toBe(true);
    expect(booleanCodec.parse('0')).toBe(false);
    expect(booleanCodec.parse('maybe')).toBeUndefined();
    expect(booleanCodec.serialize(true)).toBe('1');
    expect(booleanCodec.serialize(false)).toBe('0');
  });
  test('string list round-trips commas', () => {
    const v = ['a', 'b,c', ''];
    expect(stringListCodec.parse(stringListCodec.serialize(v))).toEqual(v.filter(() => true));
    expect(stringListCodec.parse('')).toEqual([]);
    expect(stringListCodec.parse('%E0%A4%A')).toBeUndefined();
  });
  test('date', () => {
    expect(dateCodec.parse('2026-02-28')).toBe('2026-02-28');
    expect(dateCodec.parse('2026-02-30')).toBeUndefined();
    expect(dateCodec.parse('26-1-1')).toBeUndefined();
  });
  test('enum', () => {
    const c = enumCodec(['timeline', 'map'] as const);
    expect(c.parse('map')).toBe('map');
    expect(c.parse('x')).toBeUndefined();
  });
  test('nextSearch drops default and keeps other keys', () => {
    expect(nextSearch('?q=a&view=map', 'view', stringCodec, 'timeline', 'timeline')).toBe('?q=a');
    expect(nextSearch('', 'view', stringCodec, 'timeline', 'map')).toBe('?view=map');
    expect(nextSearch('?view=map', 'view', stringCodec, 'timeline', 'timeline')).toBe('');
  });
});

function wrap(initial: string) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  );
}

function useBoth() {
  const [view, setView] = useQueryState(
    'view',
    enumCodec(['timeline', 'map'] as const),
    'timeline',
  );
  const [n, setN] = useQueryState('zoom', numberCodec, 1);
  return { view, setView, n, setN, loc: useLocation() };
}

describe('useQueryState', () => {
  test('reads value, falls back to default for missing/invalid', () => {
    const { result } = renderHook(useBoth, { wrapper: wrap('/t/x?view=bogus&zoom=4#abc') });
    expect(result.current.view).toBe('timeline');
    expect(result.current.n).toBe(4);
  });

  test('setting a value keeps the hash and other params', () => {
    const { result } = renderHook(useBoth, { wrapper: wrap('/t/x?zoom=4#secret') });
    act(() => result.current.setView('map'));
    expect(result.current.view).toBe('map');
    expect(result.current.loc.pathname).toBe('/t/x');
    expect(result.current.loc.search).toBe('?zoom=4&view=map');
    expect(result.current.loc.hash).toBe('#secret');
  });

  test('setting back to default removes the key but keeps the hash', () => {
    const { result } = renderHook(useBoth, { wrapper: wrap('/t/x?view=map#secret') });
    act(() => result.current.setView('timeline'));
    expect(result.current.loc.search).toBe('');
    expect(result.current.loc.hash).toBe('#secret');
  });

  test('two sets in one tick compose and keep the hash', () => {
    const { result } = renderHook(useBoth, { wrapper: wrap('/t/x#secret') });
    act(() => {
      result.current.setView('map');
      result.current.setN(3);
    });
    expect(result.current.loc.search).toBe('?view=map&zoom=3');
    expect(result.current.loc.hash).toBe('#secret');
  });
});

describe('app shell', () => {
  test('view switch changes ?view= and the hash survives', () => {
    render(
      <MemoryRouter initialEntries={['/t/x#abc']}>
        <App />
        <LocationProbe />
      </MemoryRouter>,
    );
    expect(screen.getByText('No events yet.')).toBeTruthy();
    act(() => screen.getByRole('button', { name: 'Map' }).click());
    expect(screen.getByTestId('loc').textContent).toBe('/t/x?view=map#abc');
    expect(screen.getByText('MapView')).toBeTruthy();
    act(() => screen.getByRole('button', { name: 'Timeline' }).click());
    expect(screen.getByTestId('loc').textContent).toBe('/t/x#abc');
  });
});

function LocationProbe() {
  const l = useLocation();
  return <span data-testid="loc">{l.pathname + l.search + l.hash}</span>;
}
