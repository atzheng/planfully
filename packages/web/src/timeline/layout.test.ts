import type { Event, RosterMember } from '@planfully/shared';
import { expect, test } from 'vitest';
import { initialScrollMs, layoutEvents, MIN_BLOCK_PX, type LaneSpec } from './layout';
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
  const f = ev('2026-06-01T09:00', null, { type: 'flight' });
  const d = ev('2026-06-01T09:00', null, { type: 'dining' });
  const f2 = ev('2026-06-01T09:00', null, { type: 'flight' });
  const r = layoutEvents([d, f, f2], scale, { mode: 'type', roster: [] });
  expect(r.lanes.map((l) => l.key)).toEqual(['flight', 'dining']);
  expect(r.blocks.filter((b) => b.laneKey === 'flight')).toHaveLength(2);
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
