import { EVENT_TYPES, eventInterval } from '@planfully/shared';
import type { Event, RosterMember } from '@planfully/shared';
import type { TimeScale } from './scale';

export const LANE_MODES = ['none', 'type', 'participant'] as const;
export type LaneMode = (typeof LANE_MODES)[number];
export type LaneSpec = {
  mode: LaneMode;
  roster: readonly RosterMember[];
  /** Participant mode: show only these participants' lanes (the `who` filter); empty/absent = all. */
  only?: readonly string[];
  /** Participant mode: participants whose lanes are hidden (the `who` exclude list). */
  exclude?: readonly string[];
};
export type Lane = { key: string; label: string };
export type Block = {
  eventId: string;
  laneKey: string;
  top: number;
  height: number;
  /** 0-based column within the lane's overlap cluster. */
  column: number;
  /** Total columns in the overlap cluster this block belongs to (block width = 1 / columns). */
  columns: number;
  /** Columns this block occupies (>= 1): it extends right over columns with no time-overlapping block. */
  span: number;
  /** Cascade level (0..MAX_DEPTH) among time-overlapping blocks sharing this column; inset by depth * DEPTH_STEP_PX. */
  depth: number;
  /** True for a side-rail block (lodging, or any event of >= RAIL_MIN_MS): outside column allocation. */
  rail: boolean;
  /** Rail blocks: cascade slot from the lane's right edge (0 = outermost); right offset is slot * RAIL_STEP_PX. 0 otherwise. */
  railSlot: number;
  /**
   * Non-rail blocks: rail slots reserved at the lane's right edge (0..MAX_RAILS): the maximum over the block's
   * overlap cluster, so right edges line up. Width stops short by `railBudgetPx(railInset)`. 0 with no rail.
   */
  railInset: number;
};
export type Layout = { lanes: Lane[]; blocks: Block[]; unscheduled: Event[] };

/** Minimum block heights in px per render tier (see `minBlockHeight`); used for overlap detection too. */
export const MIN_BLOCK_PX = 28;
export const MIN_LINE_BLOCK_PX = 18;
export const MIN_BAR_PX = 6;
/** Zoom at or above which short events get the full-size minimum height. */
export const FULL_MIN_PX_PER_HOUR = 24;
/** Zoom at or above which short events keep a single-line (icon + title) minimum height. */
export const LINE_MIN_PX_PER_HOUR = 5;
/** Rendered heights below this are thin bars (no text); from here up a block shows one line of text. */
export const LINE_BLOCK_MIN_PX = 16;
/** Most columns an overlap cluster may use; further blocks share columns (stack) instead of narrowing. */
export const MAX_COLUMNS = 5;

/** Events at least this long (and all lodging) render as a side rail instead of taking an overlap column. */
export const RAIL_MIN_MS = 24 * 3600_000;
/** Width (and hit area) of a rail; the lowest slot of overlapping rails is fully exposed. */
export const RAIL_PX = 36;
/** Overlapping rails cascade: each slot is offset this far from the previous one, so each keeps >= this strip. */
export const RAIL_STEP_PX = 16;
/** Most cascaded rail slots at a lane edge (budget 36 + 3 * 16 = 84px); more overlapping rails share the last slot. */
export const MAX_RAILS = 4;

/** Horizontal space a lane edge reserves for `slots` cascaded rails (0 for none). */
export function railBudgetPx(slots: number): number {
  return slots <= 0 ? 0 : RAIL_PX + (slots - 1) * RAIL_STEP_PX;
}

/** Narrowest a column may get before the cluster stops adding columns and cascades instead. */
export const MIN_COLUMN_PX = 90;
/** Horizontal inset per cascade level, so each stacked block keeps an exposed strip this wide. */
export const DEPTH_STEP_PX = 16;
/**
 * Deepest cascade level (4 steps = 64px of a >= 90px column). Every block keeps an exposed strip while
 * at most (MAX_DEPTH + 1) blocks per column overlap in time; beyond that the deepest level is shared.
 */
export const MAX_DEPTH = 4;

/** Column cap for a lane `laneWidthPx` wide with `railPx` reserved for rails: floor((width - railPx) / 90) clamped to 1..MAX_COLUMNS. */
export function maxColumnsForWidth(laneWidthPx: number, railPx = 0): number {
  const n = Math.floor((laneWidthPx - railPx) / MIN_COLUMN_PX);
  return Math.min(MAX_COLUMNS, Math.max(1, Number.isFinite(n) ? n : MAX_COLUMNS));
}

/**
 * Rendered block width (px) below which a text block shows only its type icon (title and time move to
 * aria-label / title). The bead said ~48px, but measured block chrome (3px border, 13px padding, 16px icon,
 * gap) is ~37px, so 48px leaves a 1-2 character title; 64px leaves at least ~27px (3+ characters).
 */
export const ICON_ONLY_PX = 64;

/** True when a block `widthPx` wide is too narrow for readable text (one or two characters of title). */
export function isIconOnly(widthPx: number): boolean {
  return widthPx < ICON_ONLY_PX;
}

/**
 * Cascade levels a block of `availPx` (column width before the 1px margins and depth inset) can use:
 * each level costs DEPTH_STEP_PX and the block keeps at least DEPTH_STEP_PX of width. Capped at MAX_DEPTH.
 * Exact bound for exposure: a column keeps every block uncovered while at most `maxDepthFor(availPx) + 1`
 * blocks of it overlap at any instant (depth = lowest free level among overlapping earlier blocks of the
 * column, so depth <= simultaneous overlap - 1); beyond that the deepest level is shared.
 */
export function maxDepthFor(availPx: number): number {
  const room = Math.floor((availPx - 2 - DEPTH_STEP_PX) / DEPTH_STEP_PX);
  return Math.max(0, Math.min(MAX_DEPTH, room));
}

/** Vertical reach (px, each side) of a thin bar's 24px hit area beyond its box; 0 for blocks of 16px or more. */
export function hitExtensionPx(heightPx: number): number {
  return heightPx >= LINE_BLOCK_MIN_PX ? 0 : (24 - heightPx) / 2;
}

export type BlockTier = 'full' | 'line' | 'bar';

/** Minimum rendered height of a block at this zoom: shrinks as you zoom out so overlaps stay small. */
export function minBlockHeight(pxPerHour: number): number {
  if (pxPerHour >= FULL_MIN_PX_PER_HOUR) return MIN_BLOCK_PX;
  if (pxPerHour >= LINE_MIN_PX_PER_HOUR) return MIN_LINE_BLOCK_PX;
  return MIN_BAR_PX;
}

/** How a block of this rendered height is drawn: title + time, one line, or a thin type-coloured bar. */
export function blockTier(heightPx: number, fullMinPx: number): BlockTier {
  if (heightPx >= fullMinPx) return 'full';
  return heightPx >= LINE_BLOCK_MIN_PX ? 'line' : 'bar';
}

/** Lane for participant ids that are not in the roster. Only present when some event needs it. */
export const OTHER_LANE_KEY = '_other';

/** Lodging and 24h+ events leave the column allocation for the lane-edge rail (not in type lanes, which isolate them already). */
export function isRailEvent(e: Event, mode: LaneMode): boolean {
  if (mode === 'type') return false;
  const iv = eventInterval(e);
  if (!iv) return false;
  return e.type === 'lodging' || iv.end - iv.start >= RAIL_MIN_MS;
}

function laneKeys(e: Event, spec: LaneSpec, rosterIds: Set<string>): string[] {
  switch (spec.mode) {
    case 'none':
      return ['all'];
    case 'type':
      return [e.type];
    case 'participant': {
      const all =
        e.participants.length === 0
          ? spec.roster.length === 0
            ? [OTHER_LANE_KEY]
            : spec.roster.map((m) => m.id)
          : [...new Set(e.participants.map((p) => (rosterIds.has(p) ? p : OTHER_LANE_KEY)))];
      const kept = spec.exclude?.length ? all.filter((k) => !spec.exclude?.includes(k)) : all;
      return spec.only?.length ? kept.filter((k) => spec.only?.includes(k)) : kept;
    }
  }
}

/**
 * Expand-to-fill: each block extends right until the nearest column (to its right) holding a block
 * that overlaps it in time, or to the cluster edge. Overlapping blocks keep their own columns, so
 * expanded blocks never overlap visually. Blocks arrive sorted by top, so each block only scans the
 * blocks that start before it ends.
 */
function expandSpans(cluster: Block[]): void {
  const columns = cluster[0]?.columns ?? 1;
  if (columns === 1) return;
  for (const b of cluster) {
    const bottom = b.top + b.height;
    let nearest = columns;
    for (const o of cluster) {
      if (o.top >= bottom) break;
      if (o.column > b.column && o.column < nearest && o.top + o.height > b.top) nearest = o.column;
    }
    b.span = nearest - b.column;
  }
}

/**
 * Pure layout. Lanes: 'none' = one lane 'all'; 'type' = one per type present (EVENT_TYPES order);
 * 'participant' = one per roster member (roster order); an event appears once per participant, and
 * participants [] appears in every roster lane. Unknown participant ids go to an extra '_other' lane
 * (added only if needed, or if the roster is empty so lanes is never empty).
 * Within a lane, overlapping blocks (after min height) form a cluster, packed greedily into the first
 * free column (interval-graph colouring); `columns` is the cluster's column count.
 */
export function layoutEvents(
  events: Event[],
  scale: TimeScale,
  spec: LaneSpec,
  maxColumns = MAX_COLUMNS,
  laneWidthPx?: number,
): Layout {
  const minHeight = minBlockHeight(scale.pxPerHour);
  const unscheduled: Event[] = [];
  const rosterIds = new Set(spec.roster.map((m) => m.id));
  const byLane = new Map<
    string,
    { eventId: string; top: number; height: number; rail: boolean }[]
  >();
  const present = new Set<string>();

  for (const e of events) {
    const iv = eventInterval(e);
    if (!iv) {
      unscheduled.push(e);
      continue;
    }
    const top = scale.toY(iv.start);
    const height = Math.max(minHeight, scale.toY(iv.end) - top);
    const rail = isRailEvent(e, spec.mode);
    for (const key of laneKeys(e, spec, rosterIds)) {
      present.add(key);
      let list = byLane.get(key);
      if (!list) byLane.set(key, (list = []));
      list.push({ eventId: e.id, top, height, rail });
    }
  }

  let lanes: Lane[];
  if (spec.mode === 'none') {
    lanes = [{ key: 'all', label: 'All' }];
  } else if (spec.mode === 'type') {
    lanes = EVENT_TYPES.filter((t) => present.has(t)).map((t) => ({ key: t, label: t }));
  } else {
    const only = spec.only?.length ? new Set(spec.only) : null;
    lanes = spec.roster
      .filter((m) => (!only || only.has(m.id)) && !spec.exclude?.includes(m.id))
      .map((m) => ({ key: m.id, label: m.name }));
    if (
      (!only && (present.has(OTHER_LANE_KEY) || lanes.length === 0)) ||
      (only?.has(OTHER_LANE_KEY) && present.has(OTHER_LANE_KEY))
    ) {
      lanes.push({
        key: OTHER_LANE_KEY,
        label: spec.roster.length === 0 ? 'Everyone' : 'Former participants',
      });
    }
  }

  const blocks: Block[] = [];
  for (const lane of lanes) {
    const all = (byLane.get(lane.key) ?? []).sort((a, b) => a.top - b.top || b.height - a.height);
    const items = all.filter((i) => !i.rail);
    // Rails: first free slot from the lane edge (interval colouring), capped at MAX_RAILS.
    const rails: Block[] = [];
    const slotEnds: number[] = [];
    for (const it of all) {
      if (!it.rail) continue;
      let slot = slotEnds.findIndex((end) => end <= it.top);
      if (slot === -1) slot = slotEnds.length < MAX_RAILS ? slotEnds.length : MAX_RAILS - 1;
      slotEnds[slot] = Math.max(slotEnds[slot] ?? -Infinity, it.top + it.height);
      rails.push({
        eventId: it.eventId,
        laneKey: lane.key,
        top: it.top,
        height: it.height,
        column: 0,
        columns: 1,
        span: 1,
        depth: 0,
        rail: true,
        railSlot: slot,
        railInset: 0,
      });
    }
    // Column cap for this lane, leaving room for the widest rail cascade the lane has.
    const laneMax =
      laneWidthPx === undefined
        ? maxColumns
        : Math.min(maxColumns, maxColumnsForWidth(laneWidthPx, railBudgetPx(slotEnds.length)));
    const insetFor = (top: number, height: number): number => {
      let n = 0;
      // A bar's 24px hit area reaches past its box: keep it clear of rails in its vertical reach too.
      const ext = hitExtensionPx(height);
      for (const r of rails) {
        if (r.top < top + height + ext && r.top + r.height > top - ext)
          n = Math.max(n, r.railSlot + 1);
      }
      return n;
    };
    let cluster: Block[] = [];
    let clusterEnd = -Infinity;
    let colEnds: number[] = [];
    /** Per column, the blocks already placed there (for cascade depth). */
    let colItems: { end: number; depth: number }[][] = [];
    const flush = () => {
      for (const b of cluster) b.columns = colEnds.length;
      expandSpans(cluster);
      let inset = 0;
      for (const b of cluster) inset = Math.max(inset, insetFor(b.top, b.height));
      for (const b of cluster) b.railInset = inset;
      blocks.push(...cluster);
      cluster = [];
      colEnds = [];
      colItems = [];
      clusterEnd = -Infinity;
    };
    // Lowest depth not used by an earlier block of this column that overlaps in time (interval colouring), so
    // depth <= simultaneous overlap - 1. Deeper blocks are drawn on top (z-index by depth), so each keeps its strip.
    const depthIn = (c: number, top: number): number => {
      const used = new Set<number>();
      for (const o of colItems[c] ?? []) if (o.end > top) used.add(o.depth);
      let d = 0;
      while (used.has(d)) d++;
      return d;
    };
    for (const it of items) {
      if (it.top >= clusterEnd) flush();
      let col = colEnds.findIndex((end) => end <= it.top);
      if (col === -1) {
        if (colEnds.length < laneMax) col = colEnds.length;
        else {
          // Column cap reached: stack onto the column where the cascade is shallowest (none is dropped).
          let best = 0;
          for (let c = 1; c < colEnds.length; c++) {
            if (depthIn(c, it.top) < depthIn(best, it.top)) best = c;
          }
          col = best;
        }
      }
      const depth = Math.min(MAX_DEPTH, depthIn(col, it.top));
      (colItems[col] ??= []).push({ end: it.top + it.height, depth });
      colEnds[col] = Math.max(colEnds[col] ?? -Infinity, it.top + it.height);
      clusterEnd = Math.max(clusterEnd, it.top + it.height);
      cluster.push({
        eventId: it.eventId,
        laneKey: lane.key,
        top: it.top,
        height: it.height,
        column: col,
        columns: 1,
        span: 1,
        depth,
        rail: false,
        railSlot: 0,
        railInset: 0,
      });
    }
    flush();
    blocks.push(...rails);
  }
  return { lanes, blocks, unscheduled };
}

/** Where the view opens: now if inside [first start, last end] of scheduled events, else the first start (now if none). */
export function initialScrollMs(events: Event[], nowMs: number): number {
  let first = Infinity;
  let last = -Infinity;
  for (const e of events) {
    const iv = eventInterval(e);
    if (!iv) continue;
    first = Math.min(first, iv.start);
    last = Math.max(last, iv.end);
  }
  if (first === Infinity) return nowMs;
  return nowMs >= first && nowMs <= last ? nowMs : first;
}

/**
 * Drop lanes that have no blocks (e.g. a roster member whose events are all filtered out). The
 * single lane of mode 'none' is kept so the canvas is never lane-less when something is scheduled.
 */
export function withoutEmptyLanes(layout: Layout, mode: LaneMode): Layout {
  if (mode === 'none') return layout;
  const used = new Set(layout.blocks.map((b) => b.laneKey));
  return { ...layout, lanes: layout.lanes.filter((l) => used.has(l.key)) };
}

/**
 * Horizontal geometry of a non-rail block in a lane `laneWidthPx` wide. Columns divide the lane minus the
 * rail reserve (`railPx`), so a cluster's right edges line up. In px: `left = (lane - railPx) * colFrom +
 * leftInset`, `width = (lane - railPx) * colSpan - widthInset`. The cascade inset (depth) is clamped so the
 * block keeps at least DEPTH_STEP_PX of width and never vanishes. `left` / `width` are the same as CSS.
 * Rails position with `right = railSlot * RAIL_STEP_PX` and width RAIL_PX instead.
 */
export function blockGeometry(
  b: Pick<Block, 'column' | 'columns' | 'span' | 'depth' | 'railInset'>,
  laneWidthPx: number,
): {
  left: string;
  width: string;
  x0: number;
  x1: number;
  /** Cascade depth after clamping to the available width. */
  depth: number;
} {
  const railPx = railBudgetPx(b.railInset);
  const from = b.column / b.columns;
  const span = b.span / b.columns;
  const avail = (laneWidthPx - railPx) * span;
  const depth = Math.min(b.depth, maxDepthFor(avail));
  const inset = 1 + depth * DEPTH_STEP_PX;
  return {
    left: `calc((100% - ${railPx}px) * ${from} + ${inset}px)`,
    width: `calc((100% - ${railPx}px) * ${span} - ${1 + inset}px)`,
    x0: (laneWidthPx - railPx) * from + inset,
    x1: (laneWidthPx - railPx) * (from + span) - 1,
    depth,
  };
}
