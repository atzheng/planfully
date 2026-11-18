import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { numberCodec, useQueryState } from '../lib/queryState';
import type { Codec } from '../lib/queryState';
import { condensedSpan } from './condense';
import { DEFAULT_PX_PER_HOUR, MAX_PX_PER_HOUR, MIN_PX_PER_HOUR } from './scale';
import type { Gap } from './scale';

const HOUR_MS = 3_600_000;

// ---- Pure math -------------------------------------------------------------------------------

export const clampPx = (px: number): number =>
  Math.min(
    MAX_PX_PER_HOUR,
    Math.max(MIN_PX_PER_HOUR, Number.isFinite(px) ? px : DEFAULT_PX_PER_HOUR),
  );

/** The URL stores zoom as log2(pxPerHour), so equal steps feel equal. */
export const pxToZoom = (px: number): number => Math.round(Math.log2(clampPx(px)) * 1000) / 1000;
export const zoomToPx = (z: number): number => clampPx(2 ** z);

export const DEFAULT_ZOOM = pxToZoom(DEFAULT_PX_PER_HOUR);

/** Without an explicit zoom in the URL the view opens showing this many days (or the whole trip). */
export const DEFAULT_VISIBLE_DAYS = 5;

/**
 * Default zoom for a trip spanning [fromMs, toMs] in a viewport `viewportPx` tall (below the axis
 * heading): fit the first DEFAULT_VISIBLE_DAYS days, or the whole trip when it is shorter.
 */
export function defaultPxPerHour(
  fromMs: number,
  toMs: number,
  viewportPx: number,
  gaps: readonly Gap[] = [],
): number {
  const capMs = fromMs + DEFAULT_VISIBLE_DAYS * 24 * HOUR_MS;
  return fitPx(fromMs, Math.min(toMs, capMs), viewportPx, gaps);
}

// The measured default is shared by `useZoom` (Timeline) and `usePxPerHour` (everyone else), so they
// agree before the URL carries any zoom. Timeline provides it from a layout effect (before paint).
// Keyed by trip id so a default never leaks from one trip to another, and not cleared on unmount
// (the map view unmounts Timeline but other components still read the zoom).
type Measured = { key: string; px: number };
let measuredDefault: Measured | null = null;
const defaultListeners = new Set<() => void>();
export function setMeasuredDefaultPx(key: string, px: number): void {
  if (measuredDefault && measuredDefault.key === key && measuredDefault.px === px) return;
  measuredDefault = { key, px };
  defaultListeners.forEach((l) => l());
}
const subscribeDefault = (l: () => void) => {
  defaultListeners.add(l);
  return () => void defaultListeners.delete(l);
};
const getMeasuredDefault = () => measuredDefault;
const measuredFor = (m: Measured | null, key: string): number | null =>
  m && m.key === key ? m.px : null;

export const zoomCodec: Codec<number> = {
  parse: (raw) => {
    const n = numberCodec.parse(raw);
    return n === undefined ? undefined : pxToZoom(zoomToPx(n));
  },
  serialize: (z) => String(pxToZoom(zoomToPx(z))),
};

/** Like zoomCodec, but `null` means "no zoom in the URL" (the default is then measured). */
const optionalZoomCodec: Codec<number | null> = {
  parse: (raw) => zoomCodec.parse(raw),
  serialize: (z) => (z === null ? '' : zoomCodec.serialize(z)),
};

/** Factor per +/- button press. */
export const BUTTON_FACTOR = 1.5;
export const buttonPx = (px: number, dir: 1 | -1): number =>
  clampPx(dir === 1 ? px * BUTTON_FACTOR : px / BUTTON_FACTOR);

/** Wheel gesture (ctrl/cmd + wheel, trackpad pinch): exponential in deltaY, capped per event. */
export function wheelPx(px: number, deltaY: number, deltaMode = 0): number {
  const lines = deltaMode === 1 ? 16 : deltaMode === 2 ? 100 : 1;
  const d = Math.max(-60, Math.min(60, deltaY * lines));
  return clampPx(px * Math.exp(-d * 0.005));
}

/** Touch pinch: pxPerHour scales with finger distance. */
export function pinchPx(startPx: number, startDist: number, dist: number): number {
  if (!(startDist > 0) || !(dist > 0)) return clampPx(startPx);
  return clampPx(startPx * (dist / startDist));
}

/** Safari trackpad pinch: `scale` is relative to the start of the gesture. */
export const gesturePx = (startPx: number, scale: number): number =>
  scale > 0 ? clampPx(startPx * scale) : clampPx(startPx);

type GestureLike = Event & { scale: number; clientY: number };

/**
 * Safari fires gesturestart/change/end for trackpad pinch instead of ctrl+wheel. Prevents the page
 * zoom and reports the new px/h with the pointer's y (client coordinates). Returns a cleanup.
 */
export function attachGestureZoom(
  el: HTMLElement,
  getPx: () => number,
  onZoom: (px: number, clientY: number) => void,
): () => void {
  let start = 0;
  const onStart = (ev: Event) => {
    ev.preventDefault();
    start = getPx();
  };
  const onChange = (ev: Event) => {
    ev.preventDefault();
    const g = ev as GestureLike;
    onZoom(gesturePx(start || getPx(), g.scale), g.clientY);
  };
  const onEnd = (ev: Event) => ev.preventDefault();
  el.addEventListener('gesturestart', onStart);
  el.addEventListener('gesturechange', onChange);
  el.addEventListener('gestureend', onEnd);
  return () => {
    el.removeEventListener('gesturestart', onStart);
    el.removeEventListener('gesturechange', onChange);
    el.removeEventListener('gestureend', onEnd);
  };
}

/**
 * pxPerHour that fits [fromMs, toMs] into `viewportPx`. With condensed `gaps`, the collapsed part has
 * a fixed height, so only the remaining (busy) hours share what is left of the viewport.
 */
export function fitPx(
  fromMs: number,
  toMs: number,
  viewportPx: number,
  gaps: readonly Gap[] = [],
): number {
  if (!(toMs > fromMs) || !(viewportPx > 0)) return DEFAULT_PX_PER_HOUR;
  const { busyHours, fixedPx } = condensedSpan(gaps, fromMs, toMs);
  if (!(busyHours > 0) || viewportPx <= fixedPx) return MIN_PX_PER_HOUR;
  return clampPx((viewportPx - fixedPx) / busyHours);
}

/** scrollTop that puts `ms` at `y` px below the top of the scroller. */
export function scrollTopForPointer(
  scale: { toY(ms: number): number },
  ms: number,
  headingPx: number,
  y: number,
): number {
  return Math.max(0, scale.toY(ms) + headingPx - y);
}

/** Blocks at least this tall show a second line (time) in the full tier. */
export const SECONDARY_TEXT_MIN_PX = 44;

// ---- Hooks -----------------------------------------------------------------------------------

const URL_DEBOUNCE_MS = 250;

/**
 * Live zoom state backed by query key `zoom`. `setPx` updates immediately (every frame of a gesture)
 * and writes the URL (replace) once the gesture pauses.
 */
export function useZoom(tripKey: string): {
  pxPerHour: number;
  setPx(px: number): void;
  /** True while there is neither a zoom in the URL nor a measured default for this trip yet. */
  needsDefault: boolean;
  /** True while the default may still be refitted: no zoom in the URL and the user has not zoomed. */
  autoFit: boolean;
} {
  const [urlZ, setUrlZ] = useQueryState('zoom', optionalZoomCodec, null, { replace: true });
  const measured = measuredFor(useSyncExternalStore(subscribeDefault, getMeasuredDefault), tripKey);
  // Set by the user (gesture, +/-, Fit); until then the URL, or the measured default, decides.
  const [userPx, setPxState] = useState<number | null>(null);
  const px = userPx ?? (urlZ !== null ? zoomToPx(urlZ) : (measured ?? DEFAULT_PX_PER_HOUR));
  const written = useRef(urlZ);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPx = useRef<number | null>(null);
  const setUrl = useRef(setUrlZ);
  setUrl.current = setUrlZ;

  // External URL change (back/forward, link) that our own write did not cause.
  useEffect(() => {
    if (urlZ !== written.current) {
      // Cancel a pending write so it cannot overwrite the external change.
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pendingPx.current = null;
      written.current = urlZ;
      setPxState(null);
    }
  }, [urlZ]);

  const setPx = useCallback((next: number) => {
    const v = clampPx(next);
    setPxState(v);
    if (timer.current) clearTimeout(timer.current);
    pendingPx.current = v;
    timer.current = setTimeout(() => {
      timer.current = null;
      pendingPx.current = null;
      written.current = pxToZoom(v);
      setUrl.current(written.current);
    }, URL_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      // Flush on unmount so a quick navigation keeps the zoom.
      if (pendingPx.current !== null) {
        written.current = pxToZoom(pendingPx.current);
        setUrl.current(written.current);
        pendingPx.current = null;
      }
    },
    [],
  );
  return {
    pxPerHour: px,
    setPx,
    needsDefault: urlZ === null && measured === null,
    autoFit: urlZ === null && userPx === null,
  };
}

/** The URL's zoom as pxPerHour, for components that only read it. Timeline itself uses `useZoom`. */
export function usePxPerHour(tripKey?: string): number {
  const [z] = useQueryState('zoom', optionalZoomCodec, null, { replace: true });
  const m = useSyncExternalStore(subscribeDefault, getMeasuredDefault);
  const measured = tripKey === undefined ? (m?.px ?? null) : measuredFor(m, tripKey);
  return z !== null ? zoomToPx(z) : (measured ?? DEFAULT_PX_PER_HOUR);
}
