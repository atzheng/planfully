/* eslint-disable @typescript-eslint/no-non-null-assertion -- test assertions on known fixtures */
import { describe, expect, it } from 'vitest';
import { fold, planCompaction } from '../src/fold';
import type { OpenedRecord, RecordBody } from '../src/records';
import type { Attachment, Event } from '../src/schema';
import { flightEvent, lodgingEvent } from './fixtures';

let seqCounter = 0;
const rec = (seq: number, body: RecordBody, dedupe: string | null = null): OpenedRecord => ({
  seq,
  dedupe,
  createdAt: '2026-05-01T10:00:00.000Z',
  body,
});
const put = (seq: number, event: Event, dedupe: string | null = null) =>
  rec(seq, { kind: 'put', event }, dedupe);
const patch = (seq: number, target: string, fields: Record<string, unknown>) =>
  rec(seq, { kind: 'patch', target, fields: fields as never });
const del = (seq: number, target: string) => rec(seq, { kind: 'delete', target });

const att = (id: string, kind: Attachment['kind'] = 'file'): Attachment => ({
  id,
  filename: `${id}.pdf`,
  mime: 'application/pdf',
  size: 1,
  kind,
});
const ev = (id: string, over: Partial<Event> = {}): Event => ({
  id,
  name: `Event ${id}`,
  type: 'other',
  attachments: [],
  participants: [],
  status: 'confirmed',
  source: 'email',
  createdAt: '2026-05-01T10:00:00.000Z',
  ...over,
});

interface Case {
  name: string;
  log: OpenedRecord[];
  expected: Event[];
}

const cases: Case[] = [
  {
    name: 'single put passes through',
    log: [put(1, flightEvent)],
    expected: [flightEvent],
  },
  {
    name: 'puts sharing a dedupe tag are one event, earliest id wins, later fields win',
    log: [
      put(1, ev('a', { name: 'old', notes: 'n1' }), 'tag'),
      put(2, ev('b', { name: 'new' }), 'tag'),
    ],
    expected: [ev('a', { name: 'new', notes: 'n1' })],
  },
  {
    name: 'puts sharing an event id are one event even without a tag',
    log: [put(1, ev('a', { name: 'one' })), put(2, ev('a', { name: 'two' }))],
    expected: [ev('a', { name: 'two' })],
  },
  {
    name: 'different ids and tags stay separate, ordered by (createdAt, id)',
    log: [put(1, ev('a'), 't1'), put(2, ev('b'), 't2'), put(3, ev('a', { name: 'x' }), 't1')],
    expected: [ev('a', { name: 'x' }), ev('b')],
  },
  {
    name: 'chain: tag links A and B, id links B and C',
    log: [
      put(1, ev('a', { name: 'A' }), 't'),
      put(2, ev('b', { name: 'B' }), null),
      put(3, ev('b', { name: 'B2' }), 't'),
      put(4, ev('c', { name: 'C' }), 't'),
    ],
    expected: [ev('a', { name: 'C' })],
  },
  {
    name: 'a patch can target an alias',
    log: [put(1, ev('a'), 't'), put(2, ev('b'), 't'), patch(3, 'b', { name: 'Renamed' })],
    expected: [ev('a', { name: 'Renamed', pinned: ['name'] })],
  },
  {
    name: 'a patch can target the canonical id',
    log: [put(1, ev('a'), 't'), put(2, ev('b'), 't'), patch(3, 'a', { notes: 'hi' })],
    expected: [ev('a', { name: 'Event b', notes: 'hi', pinned: ['notes'] })],
  },
  {
    name: 'attachments union by id across puts',
    log: [
      put(1, ev('a', { attachments: [att('x'), att('y')] }), 't'),
      put(2, ev('a', { attachments: [att('y'), att('z', 'source-email')] }), 't'),
    ],
    expected: [ev('a', { attachments: [att('x'), att('y'), att('z', 'source-email')] })],
  },
  {
    name: 'absent optional fields in a later put keep earlier values',
    log: [
      put(1, ev('a', { notes: 'keep', start: flightEvent.start }), 't'),
      put(2, ev('a', { name: 'n2' }), 't'),
    ],
    expected: [ev('a', { notes: 'keep', start: flightEvent.start, name: 'n2' })],
  },
  {
    name: 'patched fields are pinned against later email puts',
    log: [
      put(1, ev('a', { name: 'orig', notes: 'n' }), 't'),
      patch(2, 'a', { name: 'mine' }),
      put(3, ev('a', { name: 'email says', notes: 'n2' }), 't'),
    ],
    expected: [ev('a', { name: 'mine', notes: 'n2', pinned: ['name'] })],
  },
  {
    name: 'pinned fields can still be overwritten by a manual put',
    log: [
      put(1, ev('a', { name: 'orig' }), 't'),
      patch(2, 'a', { name: 'mine' }),
      put(3, ev('a', { name: 'manual', source: 'manual' }), 't'),
    ],
    expected: [ev('a', { name: 'manual', source: 'manual', pinned: ['name'] })],
  },
  {
    name: 'a patch replaces the attachment list; a later email adds attachments without removing',
    log: [
      put(1, ev('a', { attachments: [att('x'), att('y')] }), 't'),
      patch(2, 'a', { attachments: [att('y')] }),
      put(3, ev('a', { attachments: [att('w')] }), 't'),
    ],
    expected: [ev('a', { attachments: [att('y'), att('w')], pinned: ['attachments'] })],
  },
  {
    name: 'cancelled sticks across later email puts',
    log: [
      put(1, ev('a', { status: 'cancelled' }), 't'),
      put(2, ev('a', { status: 'confirmed', name: 'rebooked?' }), 't'),
    ],
    expected: [ev('a', { status: 'cancelled', name: 'rebooked?' })],
  },
  {
    name: 'a patch can set cancelled back to confirmed, and then it is pinned',
    log: [
      put(1, ev('a', { status: 'cancelled' }), 't'),
      patch(2, 'a', { status: 'confirmed' }),
      put(3, ev('a', { status: 'cancelled' }), 't'),
    ],
    expected: [ev('a', { status: 'confirmed', pinned: ['status'] })],
  },
  {
    name: 'a cancelling email put cancels a confirmed event',
    log: [put(1, ev('a'), 't'), put(2, ev('a', { status: 'cancelled' }), 't')],
    expected: [ev('a', { status: 'cancelled' })],
  },
  {
    name: 'delete omits the event',
    log: [put(1, ev('a'), 't'), put(2, ev('b'), 't2'), del(3, 'a')],
    expected: [ev('b')],
  },
  {
    name: 'delete by alias omits the event',
    log: [put(1, ev('a'), 't'), put(2, ev('b'), 't'), del(3, 'b')],
    expected: [],
  },
  {
    name: 'deleted events stay deleted when a later email for the same booking arrives',
    log: [put(1, ev('a'), 't'), del(2, 'a'), put(3, ev('c', { name: 'again' }), 't')],
    expected: [],
  },
  {
    name: 'patch deleted:false restores a deleted event',
    log: [put(1, ev('a'), 't'), del(2, 'a'), patch(3, 'a', { deleted: false })],
    expected: [ev('a', { deleted: false, pinned: ['deleted'] })],
  },
  {
    name: 'patch with unknown target is ignored',
    log: [put(1, ev('a')), patch(2, 'nope', { name: 'x' })],
    expected: [ev('a')],
  },
  {
    name: 'delete with unknown target is ignored',
    log: [put(1, ev('a')), del(2, 'nope')],
    expected: [ev('a')],
  },
  {
    name: 'a patch recorded before its target exists is ignored',
    log: [patch(1, 'a', { name: 'early' }), put(2, ev('a'))],
    expected: [ev('a')],
  },
  {
    name: 'patch pins every field it sets and merges with existing pins',
    log: [put(1, lodgingEvent), patch(2, lodgingEvent.id, { name: 'H', needsReview: false })],
    expected: [
      { ...lodgingEvent, name: 'H', needsReview: false, pinned: ['name', 'needsReview', 'notes'] },
    ],
  },
  {
    name: 'createdAt keeps the earliest put',
    log: [
      put(1, ev('a', { createdAt: '2026-01-01T00:00:00.000Z' }), 't'),
      put(2, ev('a', { createdAt: '2026-02-01T00:00:00.000Z' }), 't'),
    ],
    expected: [ev('a', { createdAt: '2026-01-01T00:00:00.000Z' })],
  },
];

describe('fold', () => {
  it.each(cases)('$name', ({ log, expected }) => {
    expect(fold(log)).toEqual(expected);
  });

  it.each(cases)('input order does not matter: $name', ({ log, expected }) => {
    expect(fold([...log].reverse())).toEqual(expected);
    const rotated = [...log.slice(1), ...log.slice(0, 1)];
    expect(fold(rotated)).toEqual(expected);
  });

  it('does not mutate its input', () => {
    const log = [put(1, ev('a', { attachments: [att('x')] }), 't'), patch(2, 'a', { name: 'n' })];
    const copy = structuredClone(log);
    fold(log);
    expect(log).toEqual(copy);
  });

  it('handles a few thousand records quickly', () => {
    const log: OpenedRecord[] = [];
    for (let i = 0; i < 5000; i++) {
      log.push(put(++seqCounter, ev(`e${i % 500}`), `t${i % 500}`));
      log.push(patch(++seqCounter, `e${i % 500}`, { notes: String(i) }));
    }
    const t = Date.now();
    expect(fold(log)).toHaveLength(500);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('planCompaction', () => {
  const log = [
    put(1, ev('a', { notes: 'x' }), 't'),
    put(2, ev('b', { name: 'later' }), 't'),
    patch(3, 'b', { name: 'mine' }),
    put(4, ev('a', { attachments: [att('z')] }), 't'),
    put(5, ev('other'), 'o'),
  ];

  it('emits one put per large group with the tag and the replaced seqs', () => {
    const plan = planCompaction(log);
    expect(plan).toHaveLength(1);
    expect(plan[0]!.write.dedupe).toBe('t');
    expect(plan[0]!.deleteSeqs).toEqual([1, 2, 3, 4]);
    const body = plan[0]!.write.body;
    expect(body.kind).toBe('put');
    if (body.kind === 'put') {
      expect(body.event).toEqual(fold(log)[0]);
      expect(body.event.pinned).toEqual(['name']);
    }
  });

  it('respects minRecords', () => {
    expect(planCompaction(log, 5)).toEqual([]);
    expect(planCompaction(log, 1)).toHaveLength(2);
  });

  it('keeps deleted state and pin in the compacted put', () => {
    const l = [put(1, ev('a'), 't'), put(2, ev('a'), 't'), put(3, ev('a'), 't'), del(4, 'a')];
    const [p] = planCompaction(l);
    const body = p!.write.body;
    expect(body.kind === 'put' && body.event.deleted).toBe(true);
    expect(body.kind === 'put' && body.event.pinned).toEqual(['deleted']);
  });

  it('skips groups joined by more than one dedupe tag', () => {
    const l = [
      put(1, ev('a'), 't1'),
      put(2, ev('a'), 't2'),
      put(3, ev('a'), 't1'),
      put(4, ev('a'), 't2'),
    ];
    expect(planCompaction(l)).toEqual([]);
  });

  it('does not touch ignored orphan patches', () => {
    const l = [
      patch(1, 'a', { name: 'x' }),
      put(2, ev('a')),
      put(3, ev('a')),
      put(4, ev('a')),
      put(5, ev('a')),
    ];
    const [p] = planCompaction(l);
    expect(p!.deleteSeqs).toEqual([2, 3, 4, 5]);
  });

  it('a later email after compaction still dedupes and respects pins', () => {
    const [p] = planCompaction(log);
    const after = [
      rec(10, p!.write.body, p!.write.dedupe),
      put(11, ev('c', { name: 'email again', notes: 'fresh' }), 't'),
    ];
    const [e] = fold(after);
    expect(e!.id).toBe('a');
    expect(e!.name).toBe('mine');
    expect(e!.notes).toBe('fresh');
  });
});

// ---- property test -------------------------------------------------------------------------

/** mulberry32: tiny seeded PRNG so failures reproduce. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLog(seed: number): OpenedRecord[] {
  const r = prng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const tags = ['t1', 't2', 't3', null, null];
  const n = 1 + Math.floor(r() * 30);
  const log: OpenedRecord[] = [];
  for (let i = 0; i < n; i++) {
    const seq = (i + 1) * 3;
    const k = r();
    if (k < 0.55) {
      const e: Event = ev(pick(ids), {
        name: `n${Math.floor(r() * 5)}`,
        status: pick(['confirmed', 'cancelled']),
        source: pick(['email', 'email', 'manual']),
        attachments: r() < 0.5 ? [att(pick(['x', 'y', 'z']))] : [],
      });
      if (r() < 0.5) e.notes = `note${Math.floor(r() * 3)}`;
      if (r() < 0.3) e.start = { local: '2026-06-01T10:00', tz: 'Europe/Paris' };
      if (r() < 0.2) e.pinned = [pick(['notes', 'name'])];
      log.push(put(seq, e, pick(tags)));
    } else if (k < 0.9) {
      const fields: Record<string, unknown> = {};
      if (r() < 0.5) fields.name = `p${Math.floor(r() * 5)}`;
      if (r() < 0.4) fields.notes = `pn${Math.floor(r() * 3)}`;
      if (r() < 0.3) fields.status = pick(['confirmed', 'cancelled']);
      if (r() < 0.3) fields.attachments = [att(pick(['x', 'y', 'w']))];
      if (r() < 0.1) fields.deleted = false;
      log.push(patch(seq, pick([...ids, 'ghost']), fields));
    } else {
      log.push(del(seq, pick([...ids, 'ghost'])));
    }
  }
  return log;
}

function applyPlan(log: OpenedRecord[], withDeletes: boolean, minRecords: number): OpenedRecord[] {
  const plans = planCompaction(log, minRecords);
  const del = new Set(withDeletes ? plans.flatMap((p) => p.deleteSeqs) : []);
  let seq = Math.max(0, ...log.map((l) => l.seq)) + 1;
  return [
    ...log.filter((l) => !del.has(l.seq)),
    ...plans.map((p) => rec(seq++, p.write.body, p.write.dedupe)),
  ];
}

describe('fold properties', () => {
  it('200 random logs: compaction (with or without deletes) and shuffling never change the result', () => {
    let compacted = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const log = randomLog(seed);
      const minRecords = 2 + (seed % 3);
      const expected = fold(log);
      if (planCompaction(log, minRecords).length > 0) compacted++;
      const ctx = `seed ${seed}`;
      expect(fold(applyPlan(log, true, minRecords)), ctx).toEqual(expected);
      expect(fold(applyPlan(log, false, minRecords)), ctx).toEqual(expected);
      const shuffled = [...log].sort(() => prng(seed)() - 0.5).reverse();
      expect(fold(shuffled), ctx).toEqual(expected);
    }
    // make sure the property actually exercised compaction
    expect(compacted).toBeGreaterThan(50);
  });
});
