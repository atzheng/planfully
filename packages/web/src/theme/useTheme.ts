import { useEffect, useSyncExternalStore } from 'react';
import {
  DARK_QUERY,
  THEME_KEY,
  applyTheme,
  readSetting,
  resolveTheme,
  systemPrefersDark,
  writeSetting,
  type ResolvedTheme,
  type ThemeSetting,
} from './theme';

// One shared store so every useTheme() caller (toggle, map) sees the same value.
type Snapshot = { setting: ThemeSetting; systemDark: boolean };
let snap: Snapshot = { setting: readSetting(), systemDark: systemPrefersDark() };
const listeners = new Set<() => void>();
let detach: (() => void) | null = null;

function update(next: Partial<Snapshot>) {
  const merged = { ...snap, ...next };
  if (merged.setting === snap.setting && merged.systemDark === snap.systemDark) return;
  snap = merged;
  listeners.forEach((l) => l());
}

function attach() {
  const mq = typeof matchMedia === 'function' ? matchMedia(DARK_QUERY) : null;
  const onMq = () => update({ systemDark: mq?.matches ?? false });
  // Another tab changed the choice.
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_KEY || e.key === null) update({ setting: readSetting() });
  };
  mq?.addEventListener('change', onMq);
  window.addEventListener('storage', onStorage);
  // Pick up anything that changed while nothing was subscribed.
  update({ setting: readSetting(), systemDark: mq?.matches ?? false });
  return () => {
    mq?.removeEventListener('change', onMq);
    window.removeEventListener('storage', onStorage);
  };
}

function subscribe(l: () => void) {
  if (listeners.size === 0) detach = attach();
  listeners.add(l);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      detach?.();
      detach = null;
    }
  };
}

const getSnapshot = () => snap;

export function setThemeSetting(s: ThemeSetting): void {
  writeSetting(s);
  update({ setting: s });
}

/** Current setting, the resolved theme, and a setter. Keeps <html data-theme> in step. */
export function useTheme(): {
  setting: ThemeSetting;
  resolved: ResolvedTheme;
  setSetting: (s: ThemeSetting) => void;
} {
  const { setting, systemDark } = useSyncExternalStore(subscribe, getSnapshot);
  const resolved = resolveTheme(setting, systemDark);
  useEffect(() => applyTheme(resolved), [resolved]);
  return { setting, resolved, setSetting: setThemeSetting };
}
