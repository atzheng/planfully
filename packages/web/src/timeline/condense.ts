import { eventInterval } from '@planfully/shared';
import type { Event } from '@planfully/shared';
import { GAP_PX } from './scale';
import type { Gap } from './scale';

const HOUR_MS = 3_600_000;

/** Empty stretches longer than this collapse. */
export const CONDENSE_THRESHOLD_MS = 6 * HOUR_MS;
/** Kept at full scale on each side of a collapsed stretch, so events do not touch the gap marker. */
export const GAP_MARGIN_MS = HOUR_MS;
/**
 * Events at least this long (lodging, multi-day stays) do not count as "busy": they sit in the
 * background and would otherwise keep every night from collapsing.
 */
export const BACKGROUND_EVENT_MS = 24 * HOUR_MS;

type Interval = { start: number; end: number };

/**
 * Gaps to collapse: stretches between scheduled events that are longer than `thresholdMs`, shrunk by
 * `GAP_MARGIN_MS` on both sides. Only gaps between events are returned (never before the first or
 * after the last), and background events (>= 24 h) are ignored. Sorted, non-overlapping.
 */
export function findGaps(
  intervals: readonly Interval[],
  thresholdMs = CONDENSE_THRESHOLD_MS,
): Gap[] {
  const busy = intervals
    .filter((iv) => iv.end - iv.start < BACKGROUND_EVENT_MS)
    .sort((a, b) => a.start - b.start);
  const gaps: Gap[] = [];
  let reach = -Infinity;
  for (const iv of busy) {
    if (reach !== -Infinity && iv.start - reach > thresholdMs) {
      const fromMs = reach + GAP_MARGIN_MS;
      const toMs = iv.start - GAP_MARGIN_MS;
      if (toMs > fromMs) gaps.push({ fromMs, toMs });
    }
    reach = Math.max(reach, iv.end);
  }
  return gaps;
}

export function eventGaps(events: readonly Event[], thresholdMs?: number): Gap[] {
  const ivs: Interval[] = [];
  for (const e of events) {
    const iv = eventInterval(e);
    if (iv) ivs.push(iv);
  }
  return findGaps(ivs, thresholdMs);
}

/** Label for a collapsed stretch: '14 h', or days from two days up ('3 d', '3 d 4 h'). */
export function formatGap(ms: number): string {
  const h = Math.round(ms / HOUR_MS);
  if (h < 48) return `${h} h`;
  const d = Math.floor(h / 24);
  const r = h % 24;
  return r ? `${d} d ${r} h` : `${d} d`;
}

/**
 * Height of [fromMs, toMs] on a condensed scale at `pxPerHour`: busy hours at the zoom's px/h plus
 * each gap at `min(GAP_PX, length * pxPerHour)` (a partly covered gap counts proportionally).
 * Same rule as `makeScale`. Increasing in `pxPerHour`.
 */
export function condensedPx(
  gaps: readonly Gap[],
  fromMs: number,
  toMs: number,
  pxPerHour: number,
): number {
  let busyMs = toMs - fromMs;
  let px = 0;
  for (const g of gaps) {
    const overlap = Math.min(toMs, g.toMs) - Math.max(fromMs, g.fromMs);
    if (overlap <= 0) continue;
    const len = g.toMs - g.fromMs;
    busyMs -= overlap;
    px += (Math.min(GAP_PX, (len / HOUR_MS) * pxPerHour) * overlap) / len;
  }
  return px + (busyMs / HOUR_MS) * pxPerHour;
}
