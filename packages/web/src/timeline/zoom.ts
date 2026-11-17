import { useCallback, useEffect, useRef, useState } from 'react';
import { numberCodec, useQueryState } from '../lib/queryState';
import type { Codec } from '../lib/queryState';
import { DEFAULT_PX_PER_HOUR, MAX_PX_PER_HOUR, MIN_PX_PER_HOUR } from './scale';

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

export const zoomCodec: Codec<number> = {
  parse: (raw) => {
    const n = numberCodec.parse(raw);
    return n === undefined ? undefined : pxToZoom(zoomToPx(n));
  },
  serialize: (z) => String(pxToZoom(zoomToPx(z))),
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

/** pxPerHour that fits [fromMs, toMs] into `viewportPx`. */
export function fitPx(fromMs: number, toMs: number, viewportPx: number): number {
  const hours = (toMs - fromMs) / HOUR_MS;
  if (!(hours > 0) || !(viewportPx > 0)) return DEFAULT_PX_PER_HOUR;
  return clampPx(viewportPx / hours);
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

/** Secondary block text (time) only when the block is tall enough for two lines. */
export const SECONDARY_TEXT_MIN_PX = 44;
export const showSecondary = (blockHeightPx: number): boolean =>
  blockHeightPx >= SECONDARY_TEXT_MIN_PX;

// ---- Hooks -----------------------------------------------------------------------------------

const URL_DEBOUNCE_MS = 250;

/**
 * Live zoom state backed by query key `zoom`. `setPx` updates immediately (every frame of a gesture)
 * and writes the URL (replace) once the gesture pauses.
 */
export function useZoom(): { pxPerHour: number; setPx(px: number): void } {
  const [urlZ, setUrlZ] = useQueryState('zoom', zoomCodec, DEFAULT_ZOOM, { replace: true });
  const [px, setPxState] = useState(() => zoomToPx(urlZ));
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
      setPxState(zoomToPx(urlZ));
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
  return { pxPerHour: px, setPx };
}

/** The URL's zoom as pxPerHour, for components that only read it. Timeline itself uses `useZoom`. */
export function usePxPerHour(): number {
  const [z] = useQueryState('zoom', zoomCodec, DEFAULT_ZOOM, { replace: true });
  return zoomToPx(z);
}
