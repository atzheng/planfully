export type ThemeSetting = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_KEY = 'planfully.theme';
export const THEME_SETTINGS: readonly ThemeSetting[] = ['system', 'light', 'dark'];
/** Status-bar colours; keep in sync with --bg in theme.css and the inline script in index.html. */
export const THEME_COLORS: Record<ResolvedTheme, string> = { light: '#f7f7f5', dark: '#141415' };

export function isThemeSetting(v: unknown): v is ThemeSetting {
  return v === 'system' || v === 'light' || v === 'dark';
}

/** Pure: what the page should look like for a setting and the OS preference. */
export function resolveTheme(setting: ThemeSetting, systemPrefersDark: boolean): ResolvedTheme {
  if (setting === 'light' || setting === 'dark') return setting;
  return systemPrefersDark ? 'dark' : 'light';
}

export function nextSetting(s: ThemeSetting): ThemeSetting {
  return THEME_SETTINGS[(THEME_SETTINGS.indexOf(s) + 1) % THEME_SETTINGS.length] ?? 'system';
}

export function readSetting(): ThemeSetting {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isThemeSetting(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

export function writeSetting(s: ThemeSetting): void {
  try {
    if (s === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, s);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}

export const DARK_QUERY = '(prefers-color-scheme: dark)';

export function systemPrefersDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches;
}

/** Sets data-theme on <html> (always the resolved value) and the status-bar colour. */
export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolved);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', THEME_COLORS[resolved]);
}
