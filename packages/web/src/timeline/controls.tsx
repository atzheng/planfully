// What the app bar's overflow menu needs from the timeline: Fit trip (which needs the timeline's
// scroller) and a way to open the time zone picker that lives in the canvas corner.
// Lanes, weather and the zone itself are URL state and need no bridge.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

type Api = {
  /** True while a mounted timeline can fit the trip. */
  canFit: boolean;
  fit(): void;
  tzOpen: boolean;
  setTzOpen(open: boolean): void;
  /** The timeline registers its fit action while mounted (null to unregister). */
  setFit(fn: (() => void) | null): void;
};

const Ctx = createContext<Api | null>(null);

/** Null outside a provider (the timeline rendered alone in tests). */
export function useTimelineControls(): Api | null {
  return useContext(Ctx);
}

export function TimelineControlsProvider({ children }: { children: ReactNode }) {
  const fitRef = useRef<(() => void) | null>(null);
  const [canFit, setCanFit] = useState(false);
  const [tzOpen, setTzOpen] = useState(false);
  const setFit = useCallback((fn: (() => void) | null) => {
    fitRef.current = fn;
    setCanFit(fn !== null);
  }, []);
  const api = useMemo<Api>(
    () => ({ canFit, fit: () => fitRef.current?.(), tzOpen, setTzOpen, setFit }),
    [canFit, tzOpen, setFit],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** Keep `fn` registered as the Fit action while mounted; pass null when it cannot run. */
export function useRegisterFit(fn: (() => void) | null): void {
  const api = useTimelineControls();
  const ref = useRef(fn);
  ref.current = fn;
  const available = fn !== null;
  const setFit = api?.setFit;
  useEffect(() => {
    if (!setFit) return;
    setFit(available ? () => ref.current?.() : null);
    return () => setFit(null);
  }, [setFit, available]);
}
