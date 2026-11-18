import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from './useTheme';

describe('useTheme', () => {
  let matches = false;
  let handlers: Array<() => void> = [];
  const add = vi.fn((_: string, h: () => void) => handlers.push(h));
  const remove = vi.fn((_: string, h: () => void) => {
    handlers = handlers.filter((x) => x !== h);
  });
  beforeEach(() => {
    matches = false;
    handlers = [];
    add.mockClear();
    remove.mockClear();
    localStorage.clear();
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return matches;
      },
      addEventListener: add,
      removeEventListener: remove,
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('follows OS changes on System and cleans up on unmount', () => {
    const { result, unmount } = renderHook(() => useTheme());
    expect(result.current.resolved).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    matches = true;
    act(() => handlers.forEach((h) => h()));
    expect(result.current.resolved).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    act(() => result.current.setSetting('light'));
    expect(result.current.resolved).toBe('light');
    expect(localStorage.getItem('planfully.theme')).toBe('light');
    unmount();
    expect(remove).toHaveBeenCalled();
    expect(handlers).toHaveLength(0);
  });
});
