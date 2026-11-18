import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const map = { panTo: vi.fn(), setZoom: vi.fn(), getZoom: vi.fn(() => 3) };
vi.mock('@vis.gl/react-google-maps', () => ({
  useMap: () => map,
  AdvancedMarker: ({ children }: { children: unknown }) => (
    <div data-testid="marker">{children as never}</div>
  ),
}));

import { LocateControl } from './LocateControl';

type Ok = (p: unknown) => void;
type Err = (e: { code: number }) => void;
let ok: Ok;
let err: Err;
const watchPosition = vi.fn((s: Ok, e: Err) => {
  ok = s;
  err = e;
  return 7;
});
const clearWatch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // Circle is only constructed with real Maps; accuracy < 5 below avoids it.
  vi.stubGlobal('google', { maps: { Circle: vi.fn(() => ({ setMap: vi.fn() })) } });
  Object.defineProperty(navigator, 'geolocation', {
    value: { watchPosition, clearWatch },
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LocateControl', () => {
  test('no geolocation request until turned on', () => {
    render(<LocateControl />);
    expect(watchPosition).not.toHaveBeenCalled();
  });

  test('granted: dot appears, re-centre pans, off stops watching', () => {
    render(<LocateControl />);
    fireEvent.click(screen.getByTestId('locate-toggle'));
    expect(watchPosition).toHaveBeenCalledTimes(1);
    act(() => ok({ coords: { latitude: 10, longitude: 20, accuracy: 3 } }));
    expect(screen.getByTestId('locate-dot')).toBeTruthy();
    expect(map.panTo).toHaveBeenCalledWith({ lat: 10, lng: 20 });
    map.panTo.mockClear();
    fireEvent.click(screen.getByTestId('locate-recentre'));
    expect(map.panTo).toHaveBeenCalledWith({ lat: 10, lng: 20 });
    fireEvent.click(screen.getByTestId('locate-toggle'));
    expect(clearWatch).toHaveBeenCalledWith(7);
    expect(screen.queryByTestId('locate-dot')).toBeNull();
  });

  test('denied: message shown, control off, stops watching', () => {
    render(<LocateControl />);
    fireEvent.click(screen.getByTestId('locate-toggle'));
    act(() => err({ code: 1 }));
    expect(screen.getByTestId('locate-message').textContent).toMatch(/denied/);
    expect(screen.getByTestId('locate-toggle').getAttribute('aria-pressed')).toBe('false');
    expect(clearWatch).toHaveBeenCalled();
  });

  test('unsupported browser: message, no crash', () => {
    Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true });
    render(<LocateControl />);
    fireEvent.click(screen.getByTestId('locate-toggle'));
    expect(screen.getByTestId('locate-message').textContent).toMatch(/not available/);
  });

  test('unmount stops watching', () => {
    const { unmount } = render(<LocateControl />);
    fireEvent.click(screen.getByTestId('locate-toggle'));
    unmount();
    expect(clearWatch).toHaveBeenCalledWith(7);
  });
});
