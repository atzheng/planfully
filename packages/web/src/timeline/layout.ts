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
      return spec.only?.length ? all.filter((k) => spec.only?.includes(k)) : all;
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
): Layout {
  const minHeight = minBlockHeight(scale.pxPerHour);
  const unscheduled: Event[] = [];
  const rosterIds = new Set(spec.roster.map((m) => m.id));
  const byLane = new Map<string, { eventId: string; top: number; height: number }[]>();
  const present = new Set<string>();

  for (const e of events) {
    const iv = eventInterval(e);
    if (!iv) {
      unscheduled.push(e);
      continue;
    }
    const top = scale.toY(iv.start);
    const height = Math.max(minHeight, scale.toY(iv.end) - top);
    for (const key of laneKeys(e, spec, rosterIds)) {
      present.add(key);
      let list = byLane.get(key);
      if (!list) byLane.set(key, (list = []));
      list.push({ eventId: e.id, top, height });
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
      .filter((m) => !only || only.has(m.id))
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
    const items = (byLane.get(lane.key) ?? []).sort((a, b) => a.top - b.top || b.height - a.height);
    let cluster: Block[] = [];
    let clusterEnd = -Infinity;
    let colEnds: number[] = [];
    let shares: number[] = [];
    const flush = () => {
      for (const b of cluster) b.columns = colEnds.length;
      expandSpans(cluster);
      blocks.push(...cluster);
      cluster = [];
      colEnds = [];
      shares = [];
      clusterEnd = -Infinity;
    };
    for (const it of items) {
      if (it.top >= clusterEnd) flush();
      let col = colEnds.findIndex((end) => end <= it.top);
      if (col === -1) {
        if (colEnds.length < maxColumns) col = colEnds.length;
        else {
          // Column cap reached: share the column that frees up first (blocks stack, none is dropped).
          let best = 0;
          for (let c = 1; c < colEnds.length; c++) {
            const bc = colEnds[best] ?? 0;
            const cc = colEnds[c] ?? 0;
            if (cc < bc || (cc === bc && (shares[c] ?? 0) < (shares[best] ?? 0))) best = c;
          }
          col = best;
          shares[col] = (shares[col] ?? 0) + 1;
        }
      }
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
      });
    }
    flush();
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
