// Compact rendering for low zoom (planfully-ieq): events are grouped per lane into day (or week)
// buckets shown as one summary chip each, instead of blocks packed into narrow overlap columns.
import { DateTime } from 'luxon';
import { eventInterval } from '@planfully/shared';
import type { Event, EventType } from '@planfully/shared';
import { MIN_BLOCK_PX } from './layout';
import type { Layout } from './layout';
import type { TimeScale } from './scale';

/** Below this pxPerHour the timeline shows summary chips (same threshold where ticks become weekly). */
export const COMPACT_BELOW_PX_PER_HOUR = 4;
/** Chip height cap; chips are at least MIN_BLOCK_PX tall because buckets are at least that tall. */
export const CHIP_MAX_PX = 44;
/** Gap kept between neighbouring chips. */
const CHIP_GAP_PX = 2;
/** Safety cap on how many buckets one event is counted in. */
const MAX_BUCKETS_PER_EVENT = 400;

export const isCompact = (pxPerHour: number): boolean => pxPerHour < COMPACT_BELOW_PX_PER_HOUR;

export type BucketUnit = 'day' | 'week';
/** A day bucket if a whole day is tall enough for a chip, otherwise a week counted from the axis origin. */
export function bucketUnit(pxPerHour: number): BucketUnit {
  return pxPerHour * 24 >= MIN_BLOCK_PX + CHIP_GAP_PX ? 'day' : 'week';
}

export type Bucket = {
  key: string;
  laneKey: string;
  unit: BucketUnit;
  startMs: number;
  endMs: number;
  top: number;
  height: number;
  /** Event ids in start order. */
  eventIds: string[];
  /** Distinct types in first-seen order. */
  types: EventType[];
};

/**
 * Group the layout's blocks into per-lane buckets by the local (display zone) day, or 7-day week counted
 * from the axis origin, each event overlaps (an event counts in every bucket it spans). `maxY` clips the last chip to the canvas.
 */
export function compactBuckets(
  layout: Layout,
  byId: ReadonlyMap<string, Event>,
  scale: TimeScale,
  zone: string,
  maxY = Infinity,
): Bucket[] {
  const unit = bucketUnit(scale.pxPerHour);
  const originDay = DateTime.fromMillis(scale.originMs, { zone }).startOf('day');
  const map = new Map<string, Bucket & { starts: number[] }>();
  for (const b of layout.blocks) {
    const e = byId.get(b.eventId);
    const iv = e && eventInterval(e);
    if (!e || !iv) continue;
    const dayOf = (ms: number) => DateTime.fromMillis(ms, { zone }).startOf('day');
    const bucketStart = (ms: number) => {
      const day = dayOf(ms);
      // Weeks count from the axis origin, so every week bucket is a full week tall (no clipped first chip).
      const weekIdx = Math.floor(Math.round(day.diff(originDay, 'days').days) / 7);
      return unit === 'day' ? day : originDay.plus({ days: weekIdx * 7 });
    };
    const step = unit === 'day' ? { days: 1 } : { weeks: 1 };
    // Every bucket the event overlaps counts it (an end exactly at midnight does not spill over).
    const lastMs = bucketStart(iv.end > iv.start ? iv.end - 1 : iv.start).toMillis();
    let n = 0;
    for (
      let start = bucketStart(iv.start);
      start.toMillis() <= lastMs && n < MAX_BUCKETS_PER_EVENT;
      n++
    ) {
      const startMs = start.toMillis();
      const next = start.plus(step);
      const key = `${b.laneKey}:${unit}:${startMs}`;
      let bk = map.get(key);
      if (!bk) {
        const top = Math.max(0, scale.toY(startMs));
        const bottom = Math.min(maxY, scale.toY(next.toMillis()));
        bk = {
          key,
          laneKey: b.laneKey,
          unit,
          startMs,
          endMs: next.toMillis(),
          top,
          height: Math.min(CHIP_MAX_PX, Math.max(MIN_BLOCK_PX, bottom - top - CHIP_GAP_PX)),
          eventIds: [],
          types: [],
          starts: [],
        };
        map.set(key, bk);
      }
      bk.eventIds.push(e.id);
      bk.starts.push(iv.start);
      if (!bk.types.includes(e.type)) bk.types.push(e.type);
      start = next;
    }
  }
  return [...map.values()].map(({ starts, ...bk }) => {
    const order = bk.eventIds
      .map((id, i) => ({ id, s: starts[i] ?? 0 }))
      .sort((a, b) => a.s - b.s)
      .map((x) => x.id);
    return { ...bk, eventIds: order };
  });
}

/** Accessible label, e.g. '3 events on Tue 12 May' / '1 event in the 7 days from 11 May'. */
export function bucketLabel(
  count: number,
  unit: BucketUnit,
  startMs: number,
  zone: string,
): string {
  const dt = DateTime.fromMillis(startMs, { zone });
  const what = `${count} ${count === 1 ? 'event' : 'events'}`;
  return unit === 'day'
    ? `${what} on ${dt.toFormat('ccc d LLL')}`
    : `${what} in the 7 days from ${dt.toFormat('d LLL')}`;
}
