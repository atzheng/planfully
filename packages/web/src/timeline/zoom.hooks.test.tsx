// @vitest-environment happy-dom
import { cleanup, renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setMeasuredDefaultPx, usePxPerHour, useZoom, zoomToPx } from './zoom';

const wrap =
  (initial: string) =>
  ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  );

const both = (trip: string) => ({ z: useZoom(trip), p: usePxPerHour(trip) });

afterEach(() => {
  cleanup();
  setMeasuredDefaultPx('none', 48);
});

describe('measured default zoom', () => {
  it('useZoom and usePxPerHour agree on the measured default', () => {
    setMeasuredDefaultPx('a', 6);
    const { result } = renderHook(() => both('a'), { wrapper: wrap('/t/a') });
    expect(result.current.z.pxPerHour).toBe(6);
    expect(result.current.p).toBe(6);
    expect(result.current.z.needsDefault).toBe(false);
    expect(result.current.z.autoFit).toBe(true);
  });
  it('an explicit ?zoom= wins over the measured default in both hooks', () => {
    setMeasuredDefaultPx('a', 6);
    const { result } = renderHook(() => both('a'), { wrapper: wrap('/t/a?zoom=5') });
    expect(result.current.z.pxPerHour).toBeCloseTo(zoomToPx(5), 5);
    expect(result.current.p).toBeCloseTo(zoomToPx(5), 5);
    expect(result.current.z.autoFit).toBe(false);
  });
  it('is keyed by trip: another trip does not inherit it', () => {
    setMeasuredDefaultPx('a', 6);
    const { result } = renderHook(() => both('b'), { wrapper: wrap('/t/b') });
    expect(result.current.z.needsDefault).toBe(true);
    expect(result.current.z.pxPerHour).toBe(48);
    expect(result.current.p).toBe(48);
  });
  it('refits on a new measurement until the user zooms', () => {
    setMeasuredDefaultPx('a', 6);
    const { result } = renderHook(() => both('a'), { wrapper: wrap('/t/a') });
    act(() => setMeasuredDefaultPx('a', 10));
    expect(result.current.z.pxPerHour).toBe(10);
    act(() => result.current.z.setPx(20));
    expect(result.current.z.autoFit).toBe(false);
    expect(result.current.z.pxPerHour).toBe(20);
    act(() => setMeasuredDefaultPx('a', 12));
    expect(result.current.z.pxPerHour).toBe(20);
  });
});
