import type { Event } from '@planfully/shared';
import { expect, test } from 'vitest';
import {
  bucketLabel,
  CHIP_MAX_PX,
  bucketUnit,
  COMPACT_BELOW_PX_PER_HOUR,
  compactBuckets,
  isCompact,
} from './compact';
import { layoutEvents, MIN_BLOCK_PX } from './layout';
import { makeScale } from './scale';

let n = 0;
function ev(start: string, over: Partial<Event> = {}): Event {
  n += 1;
  return {
    id: `c${n}`,
    name: `Event ${n}`,
    type: 'activity',
    start: { local: start, tz: 'UTC' },
    attachments: [],
    participants: [],
    status: 'confirmed',
    source: 'manual',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
const origin = Date.parse('2026-06-01T00:00:00Z');
const run = (events: Event[], px: number, mode: 'none' | 'type' = 'none') => {
  const scale = makeScale(origin, px);
  const layout = layoutEvents(events, scale, { mode, roster: [] });
  return compactBuckets(layout, new Map(events.map((e) => [e.id, e])), scale, 'UTC');
};

test('threshold and unit', () => {
  expect(isCompact(COMPACT_BELOW_PX_PER_HOUR - 0.01)).toBe(true);
  expect(isCompact(COMPACT_BELOW_PX_PER_HOUR)).toBe(false);
  expect(bucketUnit(4)).toBe('day');
  expect(bucketUnit(1.25)).toBe('day');
  expect(bucketUnit(0.5)).toBe('week');
});

test('groups by day with count, types, and start order', () => {
  const a = ev('2026-06-02T15:00', { type: 'flight' });
  const b = ev('2026-06-02T09:00', { type: 'dining' });
  const c = ev('2026-06-02T18:00', { type: 'flight' });
  const d = ev('2026-06-03T09:00');
  const out = run([a, b, c, d], 2);
  expect(out).toHaveLength(2);
  const day = out.find((x) => x.eventIds.length === 3);
  expect(day?.eventIds).toEqual([b.id, a.id, c.id]);
  expect(day?.types).toEqual(['dining', 'flight']);
  expect(day?.top).toBe(24 * 2);
});

test('weeks at minimum zoom; chips never overlap and are tappable', () => {
  const events = [
    ev('2026-06-01T09:00'),
    ev('2026-06-02T09:00'),
    ev('2026-06-09T09:00'),
    ev('2026-06-20T09:00'),
  ];
  const out = run(events, 0.5).sort((x, y) => x.top - y.top);
  expect(out.map((o) => o.eventIds.length)).toEqual([2, 1, 1]);
  for (const o of out) expect(o.height).toBeGreaterThanOrEqual(MIN_BLOCK_PX);
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    expect(cur && prev && cur.top >= prev.top + prev.height).toBe(true);
  }
});

test('separate lanes get separate buckets', () => {
  const a = ev('2026-06-02T09:00', { type: 'flight' });
  const b = ev('2026-06-02T10:00', { type: 'dining' });
  const out = run([a, b], 1, 'type');
  expect(out.map((o) => o.laneKey).sort()).toEqual(['dining', 'flight']);
});

test('weeks count from the axis origin so every chip has a full week', () => {
  const o = Date.parse('2026-06-03T00:00:00Z');
  const a = ev('2026-06-03T09:00');
  const b = ev('2026-06-11T09:00');
  const scale = makeScale(o, 0.5);
  const layout = layoutEvents([a, b], scale, { mode: 'none', roster: [] });
  const out = compactBuckets(layout, new Map([a, b].map((e) => [e.id, e])), scale, 'UTC');
  expect(out.map((x) => x.top).sort((x, y) => x - y)).toEqual([0, 84]);
  expect(out.every((x) => x.height === CHIP_MAX_PX)).toBe(true);
});

test('a multi-day event counts in every bucket it overlaps', () => {
  const hotel = ev('2026-06-01T15:00', {
    type: 'lodging',
    end: { local: '2026-06-04T00:00', tz: 'UTC' },
  });
  const out = run([hotel], 2).sort((x, y) => x.top - y.top);
  expect(out).toHaveLength(3); // Jun 1, 2, 3; ends at midnight so Jun 4 is not counted
  for (const o of out) expect(o.eventIds).toEqual([hotel.id]);
  expect(run([hotel], 0.5)).toHaveLength(1);
});

test('labels', () => {
  const ms = Date.parse('2026-05-12T00:00:00Z');
  expect(bucketLabel(3, 'day', ms, 'UTC')).toBe('3 events on Tue 12 May');
  expect(bucketLabel(1, 'week', ms, 'UTC')).toBe('1 event in the 7 days from 12 May');
});
