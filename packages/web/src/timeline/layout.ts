import { EVENT_TYPES, eventInterval } from '@planfully/shared';
import type { Event, RosterMember } from '@planfully/shared';
import type { TimeScale } from './scale';

export const LANE_MODES = ['none', 'type', 'participant'] as const;
export type LaneMode = (typeof LANE_MODES)[number];
export type LaneSpec = { mode: LaneMode; roster: readonly RosterMember[] };
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
};
export type Layout = { lanes: Lane[]; blocks: Block[]; unscheduled: Event[] };

/** Minimum block height in px so point and short events stay tappable; used for overlap detection too. */
export const MIN_BLOCK_PX = 28;

/** Lane for participant ids that are not in the roster. Only present when some event needs it. */
export const OTHER_LANE_KEY = '_other';

function laneKeys(e: Event, spec: LaneSpec, rosterIds: Set<string>): string[] {
  switch (spec.mode) {
    case 'none':
      return ['all'];
    case 'type':
      return [e.type];
    case 'participant': {
      if (e.participants.length === 0) return spec.roster.map((m) => m.id);
      const keys = e.participants.map((p) => (rosterIds.has(p) ? p : OTHER_LANE_KEY));
      return [...new Set(keys)];
    }
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
export function layoutEvents(events: Event[], scale: TimeScale, spec: LaneSpec): Layout {
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
    const height = Math.max(MIN_BLOCK_PX, scale.toY(iv.end) - top);
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
    lanes = spec.roster.map((m) => ({ key: m.id, label: m.name }));
    if (present.has(OTHER_LANE_KEY) || lanes.length === 0) {
      lanes.push({ key: OTHER_LANE_KEY, label: 'Former participants' });
    }
  }

  const blocks: Block[] = [];
  for (const lane of lanes) {
    const items = (byLane.get(lane.key) ?? []).sort((a, b) => a.top - b.top || b.height - a.height);
    let cluster: Block[] = [];
    let clusterEnd = -Infinity;
    let colEnds: number[] = [];
    const flush = () => {
      for (const b of cluster) b.columns = colEnds.length;
      blocks.push(...cluster);
      cluster = [];
      colEnds = [];
      clusterEnd = -Infinity;
    };
    for (const it of items) {
      if (it.top >= clusterEnd) flush();
      let col = colEnds.findIndex((end) => end <= it.top);
      if (col === -1) col = colEnds.length;
      colEnds[col] = it.top + it.height;
      clusterEnd = Math.max(clusterEnd, it.top + it.height);
      cluster.push({
        eventId: it.eventId,
        laneKey: lane.key,
        top: it.top,
        height: it.height,
        column: col,
        columns: 1,
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
