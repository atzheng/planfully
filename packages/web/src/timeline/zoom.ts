import { DEFAULT_PX_PER_HOUR } from './scale';

/** The single source of pxPerHour for the timeline. The zoom bead (gy4.7) replaces the body with state. */
export function usePxPerHour(): number {
  return DEFAULT_PX_PER_HOUR;
}
