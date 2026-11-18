import type { Event, RosterMember } from '@planfully/shared';
import { expect, test } from 'vitest';
import {
  initialScrollMs,
  isRailEvent,
  isIconOnly,
  ICON_ONLY_PX,
  maxDepthFor,
  MAX_RAILS,
  MAX_DEPTH,
  blockGeometry,
  railBudgetPx,
  RAIL_PX,
  RAIL_STEP_PX,
  layoutEvents,
  blockTier,
  DEPTH_STEP_PX,
  MAX_COLUMNS,
  maxColumnsForWidth,
  type Block,
  MIN_BAR_PX,
  MIN_BLOCK_PX,
  MIN_LINE_BLOCK_PX,
  minBlockHeight,
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
  const { blocks } = layoutEvents(evs, scale, none, 1000); // uncapped: the cap deliberately overlaps
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
  const a = ev('2026-06-01T09:00', '2026-06-01T12:00', {
    type: 'dining',
    participants: ['alice'],
  });
  const b = ev('2026-06-01T10:00', '2026-06-01T11:00', {
    type: 'activity',
    participants: ['alice'],
  });
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

test('min height shrinks with zoom: full, single line, thin bar', () => {
  expect(minBlockHeight(48)).toBe(MIN_BLOCK_PX);
  expect(minBlockHeight(6)).toBe(MIN_LINE_BLOCK_PX);
  expect(minBlockHeight(4.9)).toBe(MIN_BAR_PX);
  expect(MIN_BAR_PX).toBeGreaterThanOrEqual(4);
  // A 1 hour event at ~6 px/h is a legible single-line block, not a bar.
  const e = ev('2026-06-01T09:00', '2026-06-01T10:00');
  const { blocks } = layoutEvents([e], makeScale(Date.UTC(2026, 5, 1), 6), none);
  expect(blocks[0]?.height).toBe(MIN_LINE_BLOCK_PX);
  expect(blockTier(MIN_LINE_BLOCK_PX, 44)).toBe('line');
  expect(blockTier(MIN_BAR_PX, 44)).toBe('bar');
  expect(blockTier(60, 44)).toBe('full');
});

test('far zoom: every event stays its own block and columns are capped', () => {
  const far = makeScale(Date.UTC(2026, 5, 1), 0.5);
  const many = Array.from({ length: 30 }, (_, i) =>
    ev(`2026-06-01T${String(8 + (i % 12)).padStart(2, '0')}:${i < 12 ? '00' : '30'}`, null),
  );
  const { blocks } = layoutEvents(many, far, none);
  expect(blocks).toHaveLength(30);
  expect(new Set(blocks.map((b) => b.eventId)).size).toBe(30);
  for (const b of blocks) {
    expect(b.columns).toBeLessThanOrEqual(MAX_COLUMNS);
    expect(b.column).toBeLessThan(b.columns);
    expect(b.height).toBe(MIN_BAR_PX);
  }
});

test('column cap lets overflowing blocks share a column, cascaded by depth', () => {
  const evs = Array.from({ length: 4 }, () => ev('2026-06-01T09:00', '2026-06-01T10:00'));
  const { blocks } = layoutEvents(evs, scale, none, 2);
  expect(blocks.map((b) => b.column).sort()).toEqual([0, 0, 1, 1]);
  expect(blocks.map((b) => b.depth).sort()).toEqual([0, 0, 1, 1]);
  expect(blocks.every((b) => b.columns === 2)).toBe(true);
});

test('maxColumnsForWidth: floor(width / 90) clamped to 1..5', () => {
  expect(maxColumnsForWidth(331)).toBe(3);
  expect(maxColumnsForWidth(140)).toBe(1);
  expect(maxColumnsForWidth(10)).toBe(1);
  expect(maxColumnsForWidth(2000)).toBe(5);
  expect(maxColumnsForWidth(Number.NaN)).toBe(5);
});

/**
 * Every block must keep a region no later block (drawn on top) covers: a strip DEPTH_STEP_PX wide
 * over its full height, or a top band 12px tall at full width. Pixel rects use the same formulas as
 * Timeline.tsx for a lane `w` px wide.
 */
function exposed(blocks: Block[], w: number): Block[] {
  const rect = (b: Block) => {
    const x0 = (b.column / b.columns) * w + 1 + b.depth * DEPTH_STEP_PX;
    const x1 = ((b.column + b.span) / b.columns) * w - 1;
    return { x0, x1, y0: b.top, y1: b.top + b.height };
  };
  const bad: Block[] = [];
  blocks.forEach((b, i) => {
    const r = rect(b);
    const later = blocks.slice(i + 1).map(rect);
    const overlapsY = (l: { y0: number; y1: number }, y0: number, y1: number) =>
      l.y0 < y1 && y0 < l.y1;
    const strip = later.every(
      (l) => !(overlapsY(l, r.y0, r.y1) && l.x0 < r.x0 + DEPTH_STEP_PX && r.x0 < l.x1),
    );
    const bandY1 = Math.min(r.y1, r.y0 + 12);
    const band =
      bandY1 - r.y0 >= Math.min(12, r.y1 - r.y0) &&
      later.every((l) => !(overlapsY(l, r.y0, bandY1) && l.x0 < r.x1 && r.x0 < l.x1));
    if (!strip && !band) bad.push(b);
  });
  return bad;
}

test('capped columns: every block keeps an uncovered, tappable region', () => {
  const lane = 331;
  const cap = maxColumnsForWidth(lane);
  const bars = makeScale(Date.UTC(2026, 5, 1), 6);
  const lay = (evs: Event[], sc = scale) => layoutEvents(evs, sc, none, cap).blocks;
  // 7 identical events (the review's case).
  const same = Array.from({ length: 7 }, () => ev('2026-06-01T09:00', '2026-06-01T10:00'));
  expect(exposed(lay(same), lane)).toEqual([]);
  // Near miss: bars 30 minutes apart at 6 px/h (3px apart), many in a cluster.
  const near = Array.from({ length: 10 }, (_, i) =>
    ev(`2026-06-01T${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, null),
  );
  expect(exposed(lay(near, bars), lane)).toEqual([]);
  // Random events at 6 px/h.
  let seed = 11;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const f = (m: number) =>
    `2026-06-01T${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const rand: Event[] = [];
  for (let i = 0; i < 12; i++) {
    const st = Math.floor(rnd() * 20) * 30;
    rand.push(ev(f(st), f(st + 30 + Math.floor(rnd() * 8) * 30)));
  }
  const rb = lay(rand, bars);
  expect(rb).toHaveLength(12);
  expect(exposed(rb, lane)).toEqual([]);
  // Beyond columns * (MAX_DEPTH + 1) overlapping blocks the deepest level is shared: still one
  // block per event, all inside the lane.
  const crowd = lay(Array.from({ length: 40 }, () => ev('2026-06-01T09:00', '2026-06-01T10:00')));
  expect(crowd).toHaveLength(40);
  expect(crowd.every((b) => b.column < b.columns && b.columns <= cap)).toBe(true);
});

test('lodging leaves the column allocation: others keep one full-width column and reserve the rail', () => {
  const hotel = ev('2026-06-01T15:00', '2026-06-04T11:00', { type: 'lodging' });
  const a = ev('2026-06-02T09:00', '2026-06-02T12:00');
  const b = ev('2026-06-02T10:00', '2026-06-02T13:00');
  const after = ev('2026-06-05T09:00', '2026-06-05T10:00');
  const { blocks } = layoutEvents([hotel, a, b, after], scale, none);
  const h = need(blocks.find((x) => x.eventId === hotel.id));
  expect(h).toMatchObject({ rail: true, railSlot: 0, column: 0, columns: 1, railInset: 0 });
  expect(need(blocks.find((x) => x.eventId === a.id))).toMatchObject({
    rail: false,
    columns: 2,
    railInset: 1,
  });
  expect(need(blocks.find((x) => x.eventId === after.id))).toMatchObject({
    columns: 1,
    railInset: 0,
  });
});

test('a lone event beside a hotel stays a single column', () => {
  const hotel = ev('2026-06-01T15:00', '2026-06-04T11:00', { type: 'lodging' });
  const a = ev('2026-06-02T09:00', '2026-06-02T12:00');
  const { blocks } = layoutEvents([hotel, a], scale, none);
  expect(blocks.find((x) => x.eventId === a.id)).toMatchObject({
    columns: 1,
    span: 1,
    railInset: 1,
  });
});

test('24h+ non-lodging events become rails; shorter ones and type lanes do not', () => {
  const long = ev('2026-06-01T09:00', '2026-06-02T09:00');
  const short = ev('2026-06-01T09:00', '2026-06-02T08:59');
  expect(isRailEvent(long, 'none')).toBe(true);
  expect(isRailEvent(short, 'none')).toBe(false);
  expect(isRailEvent(ev('2026-06-01T09:00', '2026-06-01T10:00', { type: 'lodging' }), 'none')).toBe(
    true,
  );
  expect(isRailEvent(long, 'type')).toBe(false);
  expect(isRailEvent(ev(null, null), 'none')).toBe(false);
});

test('back-to-back hotels share rail slot 0; overlapping stays cascade into slots', () => {
  const h1 = ev('2026-06-01T15:00', '2026-06-03T11:00', { type: 'lodging' });
  const h2 = ev('2026-06-03T15:00', '2026-06-05T11:00', { type: 'lodging' });
  const { blocks } = layoutEvents([h1, h2], scale, none);
  expect(blocks.map((b) => b.railSlot)).toEqual([0, 0]);
  const o1 = ev('2026-06-01T15:00', '2026-06-05T11:00', { type: 'lodging' });
  const o2 = ev('2026-06-02T15:00', '2026-06-05T11:00', { type: 'lodging' });
  const o3 = ev('2026-06-03T15:00', '2026-06-05T11:00', { type: 'lodging' });
  const r = layoutEvents([o1, o2, o3], scale, none).blocks;
  expect(r.map((b) => b.railSlot)).toEqual([0, 1, 2]);
});

test('participant lanes: each person has own rail; exclude still hides lanes', () => {
  const ha = ev('2026-06-01T15:00', '2026-06-04T11:00', {
    type: 'lodging',
    participants: ['alice'],
  });
  const hb = ev('2026-06-01T15:00', '2026-06-04T11:00', { type: 'lodging', participants: ['bob'] });
  const spec: LaneSpec = { mode: 'participant', roster };
  const { blocks } = layoutEvents([ha, hb], scale, spec);
  expect(blocks.every((b) => b.rail && b.railSlot === 0)).toBe(true);
  expect(new Set(blocks.map((b) => b.laneKey))).toEqual(new Set(['alice', 'bob']));
  const ex = layoutEvents([ha, hb], scale, { ...spec, exclude: ['bob'] });
  expect(ex.lanes.map((l) => l.key)).toEqual(['alice']);
  expect(ex.blocks.map((b) => b.laneKey)).toEqual(['alice']);
});

/** Rails cascade from the right edge; a lower slot is drawn on top. Each must keep >= RAIL_STEP_PX uncovered. */
function railsExposed(blocks: Block[]): Block[] {
  const rails = blocks.filter((b) => b.rail);
  const range = (b: Block) => [b.railSlot * RAIL_STEP_PX, b.railSlot * RAIL_STEP_PX + RAIL_PX];
  return rails.filter((b) => {
    const [lo, hi] = range(b) as [number, number];
    const covers = rails
      .filter(
        (o) =>
          o !== b &&
          o.railSlot < b.railSlot &&
          o.top < b.top + b.height &&
          b.top < o.top + o.height,
      )
      .map((o) => range(o) as [number, number]);
    let free = 0;
    for (let x = lo; x < hi; x++) if (!covers.some(([l, h]) => x >= l && x < h)) free++;
    return free < RAIL_STEP_PX;
  });
}

test('review: overlapping rails never sit on top of one another', () => {
  const r = [
    ev('2026-06-01T00:00', '2026-06-05T00:00', { type: 'lodging' }),
    ev('2026-06-02T00:00', '2026-06-06T00:00', { type: 'lodging' }),
    ev('2026-06-03T00:00', '2026-06-07T00:00', { type: 'lodging' }),
    ev('2026-06-03T12:00', '2026-06-08T00:00', { type: 'lodging' }),
  ];
  const { blocks } = layoutEvents(r, scale, none);
  expect(new Set(blocks.map((b) => b.railSlot)).size).toBe(4);
  expect(railsExposed(blocks)).toEqual([]);
  expect(railBudgetPx(4)).toBe(RAIL_PX + 3 * RAIL_STEP_PX);
});

test('review: at 375px blocks keep width with 2 rails, capped columns and deep cascades', () => {
  const lane = 311;
  const evs = [
    ev('2026-06-01T00:00', '2026-06-04T00:00', { type: 'lodging' }),
    ev('2026-06-02T00:00', '2026-06-05T00:00', { type: 'lodging' }),
  ];
  for (let i = 0; i < 15; i++) evs.push(ev('2026-06-02T10:00', '2026-06-02T12:00'));
  const { blocks } = layoutEvents(evs, scale, none, maxColumnsForWidth(lane), lane);
  const flat = blocks.filter((x) => !x.rail);
  expect(flat).toHaveLength(15);
  for (const b of flat) {
    const g = blockGeometry(b, lane);
    expect(g.x1 - g.x0, JSON.stringify(b)).toBeGreaterThanOrEqual(DEPTH_STEP_PX);
    expect(g.x1).toBeLessThanOrEqual(lane - railBudgetPx(b.railInset));
  }
});

test('railInset is the cluster maximum, so right edges line up', () => {
  const hotel = ev('2026-06-01T08:00', '2026-06-03T00:00', { type: 'lodging' });
  const a = ev('2026-06-01T07:00', '2026-06-01T12:00');
  const b = ev('2026-06-01T11:00', '2026-06-01T13:00');
  const { blocks } = layoutEvents([hotel, a, b], scale, none);
  const flat = blocks.filter((x) => !x.rail);
  expect(flat.map((x) => x.railInset)).toEqual([1, 1]);
});

test('rails in the exposure invariant: non-rail blocks keep clear of rails', () => {
  const lane = 331;
  const hotels = [
    ev('2026-06-01T00:00', '2026-06-04T00:00', { type: 'lodging' }),
    ev('2026-06-01T00:00', '2026-06-04T00:00', { type: 'lodging' }),
  ];
  const evs = [
    ...hotels,
    ...Array.from({ length: 9 }, () => ev('2026-06-02T09:00', '2026-06-02T10:00')),
  ];
  const { blocks } = layoutEvents(evs, scale, none, maxColumnsForWidth(lane), lane);
  const flat = blocks.filter((x) => !x.rail);
  const railLeft = lane - railBudgetPx(2);
  for (const b of flat) expect(blockGeometry(b, lane).x1).toBeLessThanOrEqual(railLeft);
  const rects = flat.map((b) => ({ b, g: blockGeometry(b, lane) }));
  const bad = rects.filter(({ b, g }, i) =>
    rects
      .slice(i + 1)
      .some(
        (o) =>
          o.b.top < b.top + b.height &&
          b.top < o.b.top + o.b.height &&
          o.g.x0 < g.x0 + DEPTH_STEP_PX &&
          g.x0 < o.g.x1,
      ),
  );
  // Only the shared deepest level may fail the strip test (9 blocks <= cols * 5 here, so none).
  expect(bad).toEqual([]);
  expect(railsExposed(blocks)).toEqual([]);
});

test('isIconOnly: blocks narrower than ICON_ONLY_PX (64) drop their text', () => {
  expect(ICON_ONLY_PX).toBe(64);
  expect(isIconOnly(63.9)).toBe(true);
  expect(isIconOnly(64)).toBe(false);
  expect(isIconOnly(0)).toBe(true);
  // A fresh 90px column is never icon-only; each cascade level costs 16px, so level 2+ is (72px at level 1, 56px at level 2).
  const lane = 90;
  const g = (depth: number) =>
    blockGeometry({ column: 0, columns: 1, span: 1, depth, railInset: 0 }, lane);
  const w = (depth: number) => g(depth).x1 - g(depth).x0;
  expect(isIconOnly(w(0))).toBe(false);
  expect(isIconOnly(w(1))).toBe(false);
  expect(isIconOnly(w(2))).toBe(true);
  // The column cap never produces a column under MIN_COLUMN_PX, so only the cascade narrows a block.
  expect(maxColumnsForWidth(179)).toBe(1);
  expect(maxColumnsForWidth(180)).toBe(2);
});

test('maxDepthFor: levels a block of a given width can cascade, capped at MAX_DEPTH', () => {
  expect(maxDepthFor(80)).toBe(3);
  expect(maxDepthFor(100)).toBe(4);
  expect(maxDepthFor(1000)).toBe(MAX_DEPTH);
  expect(maxDepthFor(10)).toBe(0);
});

/** True when no later-drawn block covers the DEPTH_STEP_PX strip at the left of block `i` (blocks drawn in array order). */
function stripUncovered(
  rects: { top: number; height: number; x0: number; x1: number }[],
  i: number,
): boolean {
  const b = rects[i] as (typeof rects)[number];
  return rects
    .slice(i + 1)
    .every(
      (l) =>
        !(
          l.top < b.top + b.height &&
          b.top < l.top + l.height &&
          l.x0 < b.x0 + DEPTH_STEP_PX &&
          b.x0 < l.x1
        ),
    );
}

test('narrow lanes (140-200px) with 0-4 rails: stacked identical blocks keep an uncovered strip up to the exact bound', () => {
  const evs = (k: number) =>
    Array.from({ length: k }, () => ev('2026-06-02T09:00', '2026-06-02T10:00'));
  for (let lane = 140; lane <= 200; lane += 10) {
    for (let rails = 0; rails <= MAX_RAILS; rails++) {
      const hotels = Array.from({ length: rails }, () =>
        ev('2026-06-01T00:00', '2026-06-04T00:00', { type: 'lodging' }),
      );
      const cols = maxColumnsForWidth(lane, railBudgetPx(rails));
      const avail = (lane - railBudgetPx(rails)) / cols;
      const bound = cols * (maxDepthFor(avail) + 1);
      for (const k of [1, bound, bound + 3, 12]) {
        const { blocks } = layoutEvents(
          [...hotels, ...evs(k)],
          scale,
          none,
          maxColumnsForWidth(lane),
          lane,
        );
        const flat = blocks.filter((x) => !x.rail);
        expect(flat).toHaveLength(k);
        const rects = flat.map((b) => ({
          ...blockGeometry(b, lane),
          top: b.top,
          height: b.height,
        }));
        const covered = rects.filter((_, i) => !stripUncovered(rects, i)).length;
        const ctx = `lane ${lane} rails ${rails} k ${k}`;
        for (const r of rects) {
          expect(r.x1 - r.x0, ctx).toBeGreaterThanOrEqual(DEPTH_STEP_PX - 2);
          expect(r.x1, ctx).toBeLessThanOrEqual(lane - railBudgetPx(rails));
        }
        // Within the bound nothing is covered; beyond it only blocks at the shared deepest level are.
        if (k <= bound) expect(covered, ctx).toBe(0);
        else expect(covered, ctx).toBeLessThanOrEqual(k - bound + cols);
      }
    }
  }
});

/** Same-slot check: a rail stays tappable if part of its height is free of later-drawn rails in its slot (lower slots are covered by railsExposed). */
function railsUncovered(blocks: Block[]): Block[] {
  const rails = blocks.filter((b) => b.rail);
  const overlaps = (a: Block, b: Block) => a.top < b.top + b.height && b.top < a.top + a.height;
  return rails.filter((b, i) => {
    const same = rails.slice(i + 1).filter((o) => o.railSlot === b.railSlot && overlaps(o, b));
    // y: is any part of b's interval free of same-slot later rails?
    const pts = [b.top, b.top + b.height - 0.01, ...same.flatMap((o) => [o.top, o.top + o.height])];
    const freeY = pts.some(
      (y) =>
        y >= b.top && y < b.top + b.height && !same.some((o) => o.top <= y && y < o.top + o.height),
    );
    return !freeY;
  });
}

test('rails beyond MAX_RAILS share the last slot but stay uncovered unless intervals are identical', () => {
  // 7 staggered, nested rails all overlapping: slots 0..3 then shared slot 3.
  const day = (d: number) => `2026-06-${String(d).padStart(2, '0')}T00:00`;
  const staggered = Array.from({ length: 7 }, (_, i) =>
    ev(day(1 + i), day(12), { type: 'lodging' }),
  );
  const { blocks } = layoutEvents(staggered, scale, none);
  expect(blocks.filter((b) => b.rail)).toHaveLength(7);
  expect(Math.max(...blocks.map((b) => b.railSlot))).toBe(MAX_RAILS - 1);
  expect(railsUncovered(blocks)).toEqual([]);
  expect(railsExposed(blocks)).toEqual([]);
  // Different ends too (nested, shorter drawn later).
  const nested = Array.from({ length: 7 }, (_, i) =>
    ev(day(1 + i), day(20 - i), { type: 'lodging' }),
  );
  expect(railsUncovered(layoutEvents(nested, scale, none).blocks)).toEqual([]);
  // Documented bound: up to MAX_RAILS simultaneous rails are always exposed; identical intervals beyond that are not.
  const four = Array.from({ length: MAX_RAILS }, () => ev(day(1), day(5), { type: 'lodging' }));
  expect(railsUncovered(layoutEvents(four, scale, none).blocks)).toEqual([]);
  const six = Array.from({ length: MAX_RAILS + 2 }, () => ev(day(1), day(5), { type: 'lodging' }));
  expect(railsUncovered(layoutEvents(six, scale, none).blocks).length).toBeGreaterThan(0);
});
