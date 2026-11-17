import { DateTime } from 'luxon';

const HOUR_MS = 3_600_000;

export type TimeScale = {
  pxPerHour: number;
  originMs: number;
  toY(ms: number): number;
  toMs(y: number): number;
};

export function makeScale(originMs: number, pxPerHour: number): TimeScale {
  if (!(pxPerHour > 0)) throw new Error('pxPerHour must be positive');
  return {
    pxPerHour,
    originMs,
    toY: (ms) => ((ms - originMs) / HOUR_MS) * pxPerHour,
    toMs: (y) => originMs + (y / pxPerHour) * HOUR_MS,
  };
}

/** Suggested zoom limits for the view (gy4.7). */
export const MIN_PX_PER_HOUR = 1;
export const MAX_PX_PER_HOUR = 240;

/** pxPerHour at or above this shows hour ticks (midnights still shown as day ticks). */
export const HOUR_TICK_MIN_PX_PER_HOUR = 30;
/** pxPerHour at or above this (and below the hour threshold) shows day ticks; below it, week ticks. */
export const DAY_TICK_MIN_PX_PER_HOUR = 4;

export type TickKind = 'hour' | 'day' | 'week';
export type Tick = { ms: number; label: string; kind: TickKind };

/** Which tick unit is shown at this zoom. Hour: >= 30 px/h. Day: >= 4 px/h. Week: below 4 px/h. */
export function tickDensity(pxPerHour: number): TickKind {
  if (pxPerHour >= HOUR_TICK_MIN_PX_PER_HOUR) return 'hour';
  if (pxPerHour >= DAY_TICK_MIN_PX_PER_HOUR) return 'day';
  return 'week';
}

const dayLabel = (dt: DateTime) => dt.toFormat('ccc LLL d');

/**
 * Axis ticks within [fromMs, toMs] (inclusive), in `tz`. Day and week ticks fall on local midnight
 * (weeks start Monday). In hour density, midnights are emitted as kind 'day' and other hours as 'hour'.
 * Stepping is calendar-based so DST changes keep ticks on local boundaries (a 23h or 25h day is one step).
 */
export function ticks(scale: TimeScale, fromMs: number, toMs: number, tz: string): Tick[] {
  if (toMs < fromMs) return [];
  const density = tickDensity(scale.pxPerHour);
  const start = DateTime.fromMillis(fromMs, { zone: tz });
  if (!start.isValid) throw new Error(`invalid zone: ${tz}`);
  const step = density === 'hour' ? { hours: 1 } : density === 'day' ? { days: 1 } : { weeks: 1 };
  const unit = density === 'hour' ? 'hour' : density === 'day' ? 'day' : 'week';
  const out: Tick[] = [];
  let cur = start.startOf(unit);
  if (cur.toMillis() < fromMs) cur = cur.plus(step);
  for (; cur.toMillis() <= toMs; cur = cur.plus(step)) {
    const ms = cur.toMillis();
    if (density === 'hour') {
      const midnight = cur.hour === 0 && cur.minute === 0;
      out.push(
        midnight
          ? { ms, label: dayLabel(cur), kind: 'day' }
          : { ms, label: cur.toFormat('h a'), kind: 'hour' },
      );
    } else if (density === 'day') {
      out.push({ ms, label: dayLabel(cur), kind: 'day' });
    } else {
      out.push({ ms, label: `Week of ${cur.toFormat('LLL d')}`, kind: 'week' });
    }
  }
  return out;
}
