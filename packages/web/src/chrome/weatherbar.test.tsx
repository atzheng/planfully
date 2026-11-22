import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AppBar } from './AppBar';
import { UNITS_KEY } from '../weather/units';
import { setUnitSystem } from '../weather/useUnits';

const state = { status: 'ready', error: null, meta: null, events: [], pending: 0 };
vi.mock('../trip/store', () => ({
  TripProvider: ({ children }: { children: ReactNode }) => children,
  useTripStore: () => ({ getState: () => ({}) }),
  useTrip: (sel?: (s: unknown) => unknown) => (sel ? sel(state) : state),
}));
vi.mock('../offline/queue', () => ({ getTripQueue: () => ({ discard: () => {} }) }));
vi.mock('../event/UploadButtons', () => ({ AddReceiptAction: () => null }));

afterEach(cleanup);
const mount = (view: 'timeline' | 'map' = 'timeline', search = '') =>
  render(
    <MemoryRouter initialEntries={[`/t/x${search}#abc`]}>
      <AppBar view={view} setView={() => {}} />
    </MemoryRouter>,
  );

describe('weather controls in the app bar (x89)', () => {
  test('the weather toggle is a bar button on the timeline, not in the menu', () => {
    mount();
    const btn = screen.getByTestId('wx-toggle');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('units-toggle')).toBeNull();
    fireEvent.click(btn);
    expect(screen.getByTestId('wx-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('units-toggle')).toBeTruthy();
  });

  test('hidden on the map view', () => {
    mount('map', '?wx=1');
    expect(screen.queryByTestId('wx-toggle')).toBeNull();
    expect(screen.queryByTestId('units-toggle')).toBeNull();
  });

  test('the units toggle flips imperial/metric and remembers it', () => {
    setUnitSystem('metric');
    mount('timeline', '?wx=1');
    const btn = screen.getByTestId('units-toggle');
    expect(btn.textContent).toBe('°C');
    fireEvent.click(btn);
    expect(screen.getByTestId('units-toggle').textContent).toBe('°F');
    expect(localStorage.getItem(UNITS_KEY)).toBe('imperial');
  });
});
