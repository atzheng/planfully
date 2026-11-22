import { useSyncExternalStore } from 'react';
import { defaultSystem, isUnitSystem, UNITS_KEY, unitsFor } from './units';
import type { Units, UnitSystem } from './units';

// A per-viewer preference (planfully-x89): localStorage, falling back to the locale's default.
function read(): UnitSystem {
  try {
    const v = localStorage.getItem(UNITS_KEY);
    if (isUnitSystem(v)) return v;
  } catch {
    /* storage unavailable */
  }
  return defaultSystem();
}

let current: UnitSystem = read();
const listeners = new Set<() => void>();

// Another tab changed the choice.
function onStorage(e: StorageEvent) {
  if (e.key !== UNITS_KEY && e.key !== null) return;
  current = read();
  listeners.forEach((x) => x());
}

function subscribe(l: () => void) {
  if (listeners.size === 0) window.addEventListener('storage', onStorage);
  listeners.add(l);
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

export function setUnitSystem(s: UnitSystem): void {
  try {
    localStorage.setItem(UNITS_KEY, s);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
  if (s === current) return;
  current = s;
  listeners.forEach((l) => l());
}

/** The viewer's unit system, its units, and a setter. Shared by every caller. */
export function useUnits(): {
  system: UnitSystem;
  units: Units;
  setSystem: (s: UnitSystem) => void;
} {
  const system = useSyncExternalStore(subscribe, () => current);
  return { system, units: unitsFor(system), setSystem: setUnitSystem };
}
