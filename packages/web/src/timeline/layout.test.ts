import type { Event, RosterMember } from '@planfully/shared';
import { expect, test } from 'vitest';
import {
  initialScrollMs,
  layoutEvents,
  MIN_BLOCK_PX,
  withoutEmptyLanes,
  type LaneSpec,
} from './layout';
import { makeScale } from './scale';

const TZ = 'UTC';
let n = 0;
function ev(start: string | null, end: string | null, over: Partial<Event> = {}): Event {
  n += 1;
  return {
    id: `e${n}`,
    name: `Event ${n}`,
    type: 'activity',
    ...(start ? { start: { local: start, tz: TZ } } : {}),
    ...(end ? { end: { local: end, tz: TZ } } : {}),
    attachments: [],
    participants: [],
    status: 'confirmed',
    source: 'manual',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
function need<T>(v: T | undefined): T {
  if (v === undefined) throw new Error('missing');
  return v;
}
const origin = Date.UTC(2026, 5, 1);
const scale = makeScale(origin, 100); // 100 px/hour
const none: LaneSpec = { mode: 'none', roster: [] };
const roster: RosterMember[] = [
  { id: 'alice', name: 'Alice', aliases: [] },
  { id: 'bob', name: 'Bob', aliases: [] },
];

test('three mutually overlapping events get three columns', () => {
  const a = ev('2026-06-01T09:00', '2026-06-01T12:00');
  const b = ev('2026-06-01T10:00', '2026-06-01T13:00');
  const c = ev('2026-06-01T11:00', '2026-06-01T14:00');
  const { blocks } = layoutEvents([a, b, c], scale, none);
  expect(blocks.map((x) => x.column).sort()).toEqual([0, 1, 2]);
  expect(blocks.every((x) => x.columns === 3)).toBe(true);
  expect(blocks.find((x) => x.eventId === a.id)).toMatchObject({ top: 900, height: 300 });
});

test('columns are reused and clusters sized independently', () => {
  const a = ev('2026-06-01T09:00', '2026-06-01T11:00');
  const b = ev('2026-06-01T10:00', '2026-06-01T13:00');
  const c = ev('2026-06-01T11:00', '2026-06-01T12:00'); // starts as a ends: reuses col 0
  const d = ev('2026-06-01T15:00', '2026-06-01T16:00'); // separate cluster
  const { blocks } = layoutEvents([d, c, b, a], scale, none);
  const by = (e: Event) => need(blocks.find((x) => x.eventId === e.id));
  expect([by(a).column, by(b).column, by(c).column]).toEqual([0, 1, 0]);
  expect([by(a).columns, by(b).columns, by(c).columns]).toEqual([2, 2, 2]);
  expect(by(d)).toMatchObject({ column: 0, columns: 1 });
});

test('minimum height applies and affects overlap', () => {
  const a = ev('2026-06-01T09:00', null);
  const b = ev('2026-06-01T09:10', null); // 16.7px later, inside a's 28px min block
  const c = ev('2026-06-01T10:00', null);
  const { blocks } = layoutEvents([a, b, c], scale, none);
  expect(blocks.every((x) => x.height === MIN_BLOCK_PX)).toBe(true);
  const by = (e: Event) => need(blocks.find((x) => x.eventId === e.id));
  expect(by(a).columns).toBe(2);
  expect(by(b).column).toBe(1);
  expect(by(c).columns).toBe(1);
});

test('multi-day event is an ordinary long block', () => {
  const l = ev('2026-06-01T15:00', '2026-06-04T11:00', { type: 'lodging' });
  const { blocks } = layoutEvents([l], scale, none);
  expect(need(blocks[0]).height).toBe(68 * 100);
});

test('type lanes: one per type present, in canonical order', () => {
  const f = ev('2026-06-01T09:00', null, { type: 'transit', mode: 'flight' });
  const d = ev('2026-06-01T09:00', null, { type: 'dining' });
  const f2 = ev('2026-06-01T09:00', null, { type: 'transit', mode: 'flight' });
  const r = layoutEvents([d, f, f2], scale, { mode: 'type', roster: [] });
  expect(r.lanes.map((l) => l.key)).toEqual(['transit', 'dining']);
  expect(r.blocks.filter((b) => b.laneKey === 'transit')).toHaveLength(2);
});

test('participant lanes: duplicated per participant, empty means everyone', () => {
  const both = ev('2026-06-01T09:00', null, { participants: ['alice', 'bob'] });
  const solo = ev('2026-06-01T12:00', null, { participants: ['bob'] });
  const all = ev('2026-06-01T15:00', null, { participants: [] });
  const r = layoutEvents([both, solo, all], scale, { mode: 'participant', roster });
  expect(r.lanes).toEqual([
    { key: 'alice', label: 'Alice' },
    { key: 'bob', label: 'Bob' },
  ]);
  const ids = (k: string) => r.blocks.filter((b) => b.laneKey === k).map((b) => b.eventId);
  expect(ids('alice')).toEqual([both.id, all.id]);
  expect(ids('bob')).toEqual([both.id, solo.id, all.id]);
});

test('participant lane for unknown ids and empty roster', () => {
  const x = ev('2026-06-01T09:00', null, { participants: ['zed'] });
  const r = layoutEvents([x], scale, { mode: 'participant', roster });
  expect(r.lanes.map((l) => l.key)).toEqual(['alice', 'bob', '_other']);
  expect(r.blocks).toHaveLength(1);
  const r2 = layoutEvents([x], scale, { mode: 'participant', roster: [] });
  expect(r2.lanes.map((l) => l.key)).toEqual(['_other']);
  expect(r.lanes[2]?.label).toBe('Former participants');
});

test('withoutEmptyLanes hides participant lanes with no events but keeps the single lane', () => {
  const x = ev('2026-06-01T09:00', null, { participants: ['alice'] });
  const r = layoutEvents([x], scale, { mode: 'participant', roster });
  expect(r.lanes.map((l) => l.key)).toEqual(['alice', 'bob']);
  expect(withoutEmptyLanes(r, 'participant').lanes.map((l) => l.key)).toEqual(['alice']);
  const none = layoutEvents([], scale, { mode: 'none', roster });
  expect(withoutEmptyLanes(none, 'none').lanes).toHaveLength(1);
});

test('empty roster: everyone events land in the single fallback lane', () => {
  const x = ev('2026-06-01T09:00', null, { participants: [] });
  const r = layoutEvents([x], scale, { mode: 'participant', roster: [] });
  expect(r.lanes).toEqual([{ key: '_other', label: 'Everyone' }]);
  expect(r.blocks.map((b) => b.eventId)).toEqual([x.id]);
});

test('only: participant mode shows just the selected participants lanes', () => {
  const all = ev('2026-06-01T09:00', null, { participants: [] });
  const both = ev('2026-06-01T10:00', null, { participants: ['alice', 'bob'] });
  const r = layoutEvents([all, both], scale, { mode: 'participant', roster, only: ['bob'] });
  expect(r.lanes.map((l) => l.key)).toEqual(['bob']);
  expect(r.blocks.map((b) => b.laneKey)).toEqual(['bob', 'bob']);
});

test('unscheduled events are separated', () => {
  const u = ev(null, null);
  const s = ev('2026-06-01T09:00', null);
  const r = layoutEvents([u, s], scale, none);
  expect(r.unscheduled).toEqual([u]);
  expect(r.blocks.map((b) => b.eventId)).toEqual([s.id]);
});

test('initialScrollMs', () => {
  const a = ev('2026-06-01T09:00', '2026-06-01T12:00');
  const b = ev('2026-06-03T09:00', '2026-06-03T10:00');
  const first = Date.UTC(2026, 5, 1, 9);
  const mid = Date.UTC(2026, 5, 2);
  expect(initialScrollMs([b, a, ev(null, null)], mid)).toBe(mid);
  expect(initialScrollMs([a, b], Date.UTC(2027, 0, 1))).toBe(first);
  expect(initialScrollMs([a, b], Date.UTC(2025, 0, 1))).toBe(first);
  expect(initialScrollMs([], mid)).toBe(mid);
});

test('few hundred events lay out quickly', () => {
  const evs = Array.from({ length: 500 }, (_, i) =>
    ev(
      `2026-06-${String(1 + (i % 28)).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:00`,
      null,
    ),
  );
  const t = performance.now();
  layoutEvents(evs, scale, none);
  expect(performance.now() - t).toBeLessThan(200);
});

test('expand: a block with nothing to its right spans to the lane edge', () => {
  const a = ev('2026-06-01T09:00', '2026-06-01T12:00'); // col 0
  const b = ev('2026-06-01T09:00', '2026-06-01T10:00'); // col 1
  const c = ev('2026-06-01T09:00', '2026-06-01T10:00'); // col 2
  const e = ev('2026-06-01T10:30', '2026-06-01T12:00'); // reuses col 1; col 2 is free beside it
  const { blocks } = layoutEvents([a, b, c, e], scale, none);
  const by = (x: Event) => need(blocks.find((y) => y.eventId === x.id));
  expect(by(a)).toMatchObject({ column: 0, columns: 3, span: 1 });
  expect(by(b)).toMatchObject({ column: 1, span: 1 });
  expect(by(c)).toMatchObject({ column: 2, span: 1 });
  expect(by(e)).toMatchObject({ column: 1, columns: 3, span: 2 });
});

test('expand: chain A overlaps B overlaps C but A not C', () => {
  const a = ev('2026-06-01T09:00', '2026-06-01T10:00');
  const b = ev('2026-06-01T09:30', '2026-06-01T10:30');
  const c = ev('2026-06-01T10:15', '2026-06-01T11:00');
  const { blocks } = layoutEvents([a, b, c], scale, none);
  const by = (x: Event) => need(blocks.find((y) => y.eventId === x.id));
  expect(by(a)).toMatchObject({ column: 0, columns: 2, span: 1 });
  expect(by(b)).toMatchObject({ column: 1, columns: 2, span: 1 });
  expect(by(c)).toMatchObject({ column: 0, columns: 2, span: 1 });
});

test('expand: overlapping blocks never overlap visually (property)', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const f = (m: number) =>
    `2026-06-01T${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const evs: Event[] = [];
  for (let i = 0; i < 60; i++) {
    const s = Math.floor(rnd() * 600);
    evs.push(ev(f(s), f(s + 15 + Math.floor(rnd() * 240))));
  }
  const { blocks } = layoutEvents(evs, scale, none);
  for (const x of blocks) {
    expect(x.span).toBeGreaterThanOrEqual(1);
    expect(x.column + x.span).toBeLessThanOrEqual(x.columns);
    for (const y of blocks) {
      if (x === y) continue;
      const timeOverlap = x.top < y.top + y.height && y.top < x.top + x.height;
      const colOverlap = x.column < y.column + y.span && y.column < x.column + x.span;
      expect(timeOverlap && colOverlap).toBe(false);
    }
  }
});

test('expand: lanes by type and by person are laid out independently', () => {
  const a = ev('2026-06-01T09:00', '2026-06-01T12:00', { type: 'stay', participants: ['alice'] });
  const b = ev('2026-06-01T10:00', '2026-06-01T11:00', { type: 'activity', participants: ['alice'] });
  const byType = layoutEvents([a, b], scale, { mode: 'type', roster: [] }).blocks;
  expect(byType.every((x) => x.columns === 1 && x.span === 1)).toBe(true);
  const byPerson = layoutEvents([a, b], scale, { mode: 'participant', roster }).blocks;
  const alice = byPerson.filter((x) => x.laneKey === 'alice');
  expect(alice.map((x) => [x.columns, x.span])).toEqual([
    [2, 1],
    [2, 1],
  ]);
  expect(byPerson.filter((x) => x.laneKey === 'bob')).toEqual([]);
});
