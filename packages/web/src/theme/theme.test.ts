import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  THEME_KEY,
  mapColorScheme,
  nextSetting,
  readSetting,
  resolveTheme,
  writeSetting,
} from './theme';

describe('resolveTheme', () => {
  it('explicit settings ignore the OS', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
  it('system follows the OS', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('setting storage', () => {
  beforeEach(() => localStorage.clear());
  it('defaults to system and ignores junk', () => {
    expect(readSetting()).toBe('system');
    localStorage.setItem(THEME_KEY, 'purple');
    expect(readSetting()).toBe('system');
  });
  it('round-trips and clears for system', () => {
    writeSetting('dark');
    expect(readSetting()).toBe('dark');
    writeSetting('system');
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });
  it('cycles system, light, dark', () => {
    expect(nextSetting('system')).toBe('light');
    expect(nextSetting('light')).toBe('dark');
    expect(nextSetting('dark')).toBe('system');
  });
});

describe('mapColorScheme', () => {
  it('maps resolved themes to Google Maps schemes', () => {
    expect(mapColorScheme('dark')).toBe('DARK');
    expect(mapColorScheme('light')).toBe('LIGHT');
  });
});

describe('throwing storage', () => {
  afterEach(() => vi.restoreAllMocks());
  it('read falls back to system and write does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readSetting()).toBe('system');
    expect(() => writeSetting('dark')).not.toThrow();
  });
});
