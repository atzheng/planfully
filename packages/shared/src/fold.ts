import type { Attachment, Event } from './schema';
import type { OpenedRecord, RecordBody } from './records';

type PutBody = Extract<RecordBody, { kind: 'put' }>;

/** One logical event: the records that belong to it, in seq order. */
interface Group {
  /** puts, plus patches/deletes that resolve to this group, ascending seq */
  ops: OpenedRecord[];
  /** id of the earliest put */
  canonicalId: string;
  tags: Set<string>;
}

function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error('fold: internal invariant violated');
  return x;
}

function sortedBySeq(records: OpenedRecord[]): OpenedRecord[] {
  // Array.prototype.sort is stable, so equal seqs keep input order.
  return [...records].sort((a, b) => a.seq - b.seq);
}

/**
 * Splits the log into groups. Puts are joined by a shared non-null dedupe tag or a shared
 * event id (union-find, so chains such as A~B by tag and B~C by id collapse to one group).
 * A patch/delete joins the group that owns its target id (canonical or alias), but only if it
 * comes after that group's earliest put; otherwise the target was unknown when it was written
 * and it is ignored.
 */
function buildGroups(sorted: OpenedRecord[]): Group[] {
  const putIdx: number[] = [];
  for (let i = 0; i < sorted.length; i++) if (must(sorted[i]).body.kind === 'put') putIdx.push(i);

  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = must(parent.get(r));
    let c = x;
    while (parent.get(c) !== r) {
      const n = must(parent.get(c));
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    // keep the smaller index (earlier seq) as root
    if (ra < rb) parent.set(rb, ra);
    else if (rb < ra) parent.set(ra, rb);
  };

  const byTag = new Map<string, number>();
  const byId = new Map<string, number>();
  for (const i of putIdx) {
    parent.set(i, i);
    const rec = must(sorted[i]);
    const id = (rec.body as PutBody).event.id;
    const seenId = byId.get(id);
    if (seenId === undefined) byId.set(id, i);
    else union(i, seenId);
    if (rec.dedupe !== null) {
      const seenTag = byTag.get(rec.dedupe);
      if (seenTag === undefined) byTag.set(rec.dedupe, i);
      else union(i, seenTag);
    }
  }

  const groups = new Map<number, Group>();
  const groupOfId = new Map<string, Group>();
  for (const i of putIdx) {
    const root = find(i); // root is the earliest put of the group
    let g = groups.get(root);
    if (!g) {
      g = { ops: [], canonicalId: (must(sorted[root]).body as PutBody).event.id, tags: new Set() };
      groups.set(root, g);
    }
    const rec = must(sorted[i]);
    groupOfId.set((rec.body as PutBody).event.id, g);
    if (rec.dedupe !== null) g.tags.add(rec.dedupe);
  }
  const firstSeq = new Map<Group, number>();
  for (const [root, g] of groups) firstSeq.set(g, must(sorted[root]).seq);

  for (let i = 0; i < sorted.length; i++) {
    const rec = must(sorted[i]);
    let g: Group | undefined;
    if (rec.body.kind === 'put') {
      g = groups.get(find(i));
    } else {
      g = groupOfId.get(rec.body.target);
      if (g && rec.seq <= must(firstSeq.get(g))) g = undefined;
    }
    g?.ops.push(rec);
  }
  // Map preserves insertion order, which is ascending earliest-put order
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
  // adds its source-email attachment). A removal made by a patch can therefore be undone by a
  // later email that re-lists the attachment.
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
    next[key] = value; // attachments in a patch replace the list
    names.push(key);
  }
  const out = next as unknown as Event;
  const extra = Array.isArray(fields.pinned) ? (fields.pinned as string[]) : [];
  const p = mergePinned(state.pinned, [...names, ...extra]);
  if (p) out.pinned = p;
  return out;
}

function replay(g: Group): Event {
  let state: Event | undefined;
  for (const rec of g.ops) {
    const b = rec.body;
    if (b.kind === 'put') state = applyPut(state, b.event);
    else if (!state)
      continue; // cannot happen: ops start with the group's earliest put
    else if (b.kind === 'patch') state = applyPatch(state, b.fields as Record<string, unknown>);
    else state = applyPatch(state, { deleted: true });
  }
  return { ...must(state), id: g.canonicalId };
}

/**
 * Folds a decrypted log into the current events. Output is sorted by (createdAt, id) so it is
 * stable across compaction; callers that care about display order sort by time themselves.
 */
export function fold(records: OpenedRecord[]): Event[] {
  const out: Event[] = [];
  for (const g of buildGroups(sortedBySeq(records))) {
    const ev = replay(g);
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
 * `pinned` and `deleted`) and the seqs it replaces. Groups joined by more than one distinct
 * dedupe tag are skipped: a single record can carry only one tag, so compacting would lose
 * the link for the other.
 */
export function planCompaction(records: OpenedRecord[], minRecords = 4): CompactionPlan[] {
  const plans: CompactionPlan[] = [];
  for (const g of buildGroups(sortedBySeq(records))) {
    if (g.ops.length < minRecords || g.tags.size > 1) continue;
    plans.push({
      write: {
        body: { kind: 'put', event: replay(g) },
        dedupe: g.tags.size === 1 ? must([...g.tags][0]) : null,
      },
      deleteSeqs: g.ops.map((r) => r.seq),
    });
  }
  return plans;
}
