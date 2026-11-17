import type { Attachment, Event } from './schema';
import type { OpenedRecord, RecordBody } from './records';

/** One logical event: the records that belong to it, in replay order. */
interface Group {
  /** puts, plus patches/deletes that resolve to this group, in replay order */
  ops: OpenedRecord[];
  /** id of the earliest put (a compacted put counts as its `firstSeq`) */
  canonicalId: string;
  /** effective seq of the earliest put */
  firstSeq: number;
  /** every put id and recorded alias in the group */
  ids: Set<string>;
  tags: Set<string>;
}

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error('fold: internal invariant violated');
  return x;
}

/** Position of a record in replay order: a compacted put sits right after its `throughSeq`. */
function orderOf(r: OpenedRecord): number {
  return r.body.kind === 'put' && r.body.compaction ? r.body.compaction.throughSeq + 0.5 : r.seq;
}

/** Seq a put counts as for canonical-id choice and the orphan rule. */
function firstOf(r: OpenedRecord): number {
  return r.body.kind === 'put' && r.body.compaction ? r.body.compaction.firstSeq : r.seq;
}

/**
 * A snapshot carries removed attachment ids as extra `aliases` entries with this prefix. The
 * compaction schema is strict, so a new field would make old clients drop the whole snapshot;
 * extra aliases are valid for them (and harmless: no event id starts with the prefix).
 */
export const TOMBSTONE_PREFIX = 'attachment-removed:';

function putIds(r: OpenedRecord): string[] {
  if (r.body.kind !== 'put') return [];
  const aliases = (r.body.compaction?.aliases ?? []).filter((a) => !a.startsWith(TOMBSTONE_PREFIX));
  return [r.body.event.id, ...aliases];
}

function snapshotTombstones(r: OpenedRecord): Set<string> {
  const out = new Set<string>();
  if (r.body.kind === 'put')
    for (const a of r.body.compaction?.aliases ?? [])
      if (a.startsWith(TOMBSTONE_PREFIX)) out.add(a.slice(TOMBSTONE_PREFIX.length));
  return out;
}

function sortedForReplay(records: OpenedRecord[]): OpenedRecord[] {
  // Array.prototype.sort is stable, so full ties keep input order.
  return [...records].sort((a, b) => orderOf(a) - orderOf(b) || a.seq - b.seq);
}

/**
 * Splits the log into groups. Puts are joined by a shared non-null dedupe tag or a shared
 * event id (union-find, so chains such as A~B by tag and B~C by id collapse to one group); a
 * compacted put also owns its recorded aliases. A patch/delete joins the group that owns its
 * target id (canonical or alias), but only if it comes after the first put that introduced that
 * id; otherwise the target was unknown when it was written and it is ignored (so a later put
 * that bridges two groups does not revive patches written before their target existed).
 */
function buildGroups(sorted: OpenedRecord[]): Group[] {
  const parent: number[] = sorted.map((_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = must(parent[r]);
    let c = x;
    while (parent[c] !== r) {
      const n = must(parent[c]);
      parent[c] = r;
      c = n;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const byKey = new Map<string, number>();
  const join = (key: string, i: number): void => {
    const seen = byKey.get(key);
    if (seen === undefined) byKey.set(key, i);
    else union(i, seen);
  };
  // seq at which each id first appeared in a put (a compacted put introduces its aliases at its
  // `firstSeq`); a patch to an id counts only after this, wherever later puts merge the groups.
  const introSeq = new Map<string, number>();
  sorted.forEach((rec, i) => {
    if (rec.body.kind !== 'put') return;
    for (const id of putIds(rec)) {
      introSeq.set(id, Math.min(introSeq.get(id) ?? Infinity, firstOf(rec)));
      join('i:' + id, i);
    }
    if (rec.dedupe !== null) join('d:' + rec.dedupe, i);
  });

  const groups = new Map<number, Group>();
  const groupOfId = new Map<string, Group>();
  // the earliest put of each group, by (firstOf, seq)
  const earliest = new Map<Group, OpenedRecord>();
  sorted.forEach((rec, i) => {
    if (rec.body.kind !== 'put') return;
    const root = find(i);
    let g = groups.get(root);
    if (!g) {
      g = { ops: [], canonicalId: '', firstSeq: Infinity, ids: new Set(), tags: new Set() };
      groups.set(root, g);
    }
    const e = earliest.get(g);
    if (!e || firstOf(rec) < firstOf(e) || (firstOf(rec) === firstOf(e) && rec.seq < e.seq)) {
      earliest.set(g, rec);
      g.firstSeq = firstOf(rec);
      g.canonicalId = rec.body.event.id;
    }
    for (const id of putIds(rec)) {
      g.ids.add(id);
      groupOfId.set(id, g);
    }
    if (rec.dedupe !== null) g.tags.add(rec.dedupe);
  });

  sorted.forEach((rec, i) => {
    let g: Group | undefined;
    if (rec.body.kind === 'put') g = groups.get(find(i));
    else {
      g = groupOfId.get(rec.body.target);
      if (g && rec.seq <= (introSeq.get(rec.body.target) ?? Infinity)) g = undefined;
    }
    g?.ops.push(rec);
  });
  return [...groups.values()];
}

const PUT_SKIP = new Set(['id', 'pinned', 'attachments', 'createdAt']);

function unionAttachments(a: Attachment[], b: Attachment[]): Attachment[] {
  const seen = new Set(a.map((x) => x.id));
  const out = [...a];
  for (const x of b) {
    if (!seen.has(x.id)) {
      seen.add(x.id);
      out.push(x);
    }
  }
  return out;
}

function mergePinned(a: string[] | undefined, b: Iterable<string>): string[] | undefined {
  const s = new Set(a ?? []);
  for (const x of b) s.add(x);
  return s.size === 0 ? undefined : [...s].sort();
}

function applyPut(state: Event | undefined, ev: Event): Event {
  if (!state) {
    const first: Event = { ...ev, attachments: unionAttachments([], ev.attachments) };
    const pinned = mergePinned(undefined, ev.pinned ?? []);
    if (pinned) first.pinned = pinned;
    else delete first.pinned;
    return first;
  }
  const next: Record<string, unknown> = { ...state };
  const pinned = new Set(state.pinned ?? []);
  const fromEmail = ev.source === 'email';
  for (const [key, value] of Object.entries(ev)) {
    if (value === undefined || PUT_SKIP.has(key)) continue;
    if (fromEmail && pinned.has(key)) continue;
    // cancelled sticks across email puts
    if (fromEmail && key === 'status' && state.status === 'cancelled') continue;
    next[key] = value;
  }
  const out = next as unknown as Event;
  // Attachments always union, even when pinned: they are additive provenance (a later email
  // adds its source-email attachment). `replay` filters out ones a patch removed.
  out.attachments = unionAttachments(state.attachments, ev.attachments);
  // createdAt stays the earliest put's
  const p = mergePinned(state.pinned, ev.pinned ?? []);
  if (p) out.pinned = p;
  return out;
}

function applyPatch(state: Event, fields: Record<string, unknown>): Event {
  const next: Record<string, unknown> = { ...state };
  const names: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || key === 'id' || key === 'pinned') continue;
    if (value === null)
      Reflect.deleteProperty(next, key); // null clears an optional field
    else next[key] = value; // attachments in a patch replace the list
    names.push(key);
  }
  const out = next as unknown as Event;
  const extra = Array.isArray(fields.pinned) ? (fields.pinned as string[]) : [];
  const p = mergePinned(state.pinned, [...names, ...extra]);
  if (p) out.pinned = p;
  return out;
}

interface Replayed {
  event: Event;
  /** attachment ids a patch removed and no later patch re-added (emails cannot re-add them) */
  tombstones: Set<string>;
}

function replay(g: Group): Replayed {
  let state: Event | undefined;
  let tombs = new Set<string>();
  for (const rec of g.ops) {
    const b = rec.body;
    if (b.kind === 'put') {
      if (b.compaction) {
        // a compacted put is a snapshot: it replaces the state wholesale, whatever the pins say
        state = applyPut(undefined, b.event);
        tombs = snapshotTombstones(rec);
      } else {
        const attachments = b.event.attachments.filter((a) => !tombs.has(a.id));
        state = applyPut(state, { ...b.event, attachments });
      }
    } else if (!state)
      continue; // cannot happen: ops start with the group's earliest put
    else if (b.kind === 'patch') {
      const fields = b.fields as Record<string, unknown>;
      if (Array.isArray(fields.attachments)) {
        const kept = new Set((fields.attachments as Attachment[]).map((a) => a.id));
        for (const a of state.attachments) if (!kept.has(a.id)) tombs.add(a.id);
        for (const id of kept) tombs.delete(id);
      }
      state = applyPatch(state, fields);
    } else state = applyPatch(state, { deleted: true });
  }
  return { event: { ...must(state), id: g.canonicalId }, tombstones: tombs };
}

/**
 * Folds a decrypted log into the current events. Output is sorted by (createdAt, id) so it is
 * stable across compaction; callers that care about display order sort by time themselves.
 */
export function fold(records: OpenedRecord[]): Event[] {
  const out: Event[] = [];
  for (const g of buildGroups(sortedForReplay(records))) {
    const ev = replay(g).event;
    if (ev.deleted !== true) out.push(ev);
  }
  return out.sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
  );
}

export interface CompactionPlan {
  write: { body: RecordBody; dedupe: string | null };
  deleteSeqs: number[];
}

/**
 * For each group with at least `minRecords` records, one put holding the folded event (with
 * `pinned` and `deleted`) plus a `compaction` marker, and the seqs it replaces. The marker
 * carries the group's first seq and aliases and the last replaced seq, so the compacted put
 * behaves as if it still sat where the records it replaces were: patches written after
 * `throughSeq` (even ones that landed before the compacted put did) apply on top of it, and
 * patches to an alias still resolve. A group with several dedupe tags gets one identical
 * snapshot per tag. Attachment tombstones ride in the snapshot's `aliases` (see TOMBSTONE_PREFIX).
 */
export function planCompaction(records: OpenedRecord[], minRecords = 4): CompactionPlan[] {
  const plans: CompactionPlan[] = [];
  for (const g of buildGroups(sortedForReplay(records))) {
    if (g.ops.length < minRecords) continue;
    // Already compacted: only snapshots with the same content (one per tag) remain.
    const first = JSON.stringify(g.ops[0]?.body);
    if (
      g.ops.every(
        (r) => r.body.kind === 'put' && r.body.compaction && JSON.stringify(r.body) === first,
      )
    )
      continue;
    const { event, tombstones } = replay(g);
    const deleteSeqs = g.ops.map((r) => r.seq);
    const compaction = {
      firstSeq: g.firstSeq,
      throughSeq: Math.max(...deleteSeqs),
      aliases: [
        ...[...g.ids].filter((id) => id !== g.canonicalId).sort(),
        ...[...tombstones].sort().map((id) => TOMBSTONE_PREFIX + id),
      ],
    };
    // One record carries one dedupe tag, so a group with several tags gets one identical
    // snapshot per tag (later emails with any of those tags keep joining the group). The
    // deletes ride on the last plan: stopping part way leaves every tag still covered.
    const tags: (string | null)[] = g.tags.size === 0 ? [null] : [...g.tags].sort();
    tags.forEach((dedupe, i) => {
      plans.push({
        write: { body: { kind: 'put', event, compaction }, dedupe },
        deleteSeqs: i === tags.length - 1 ? deleteSeqs : [],
      });
    });
  }
  return plans;
}
