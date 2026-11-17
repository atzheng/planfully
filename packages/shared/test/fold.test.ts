/* eslint-disable @typescript-eslint/no-non-null-assertion -- test assertions on known fixtures */
import { describe, expect, it } from 'vitest';
import { fold as legacyFold } from './legacyFold';
import { fold, planCompaction, TOMBSTONE_PREFIX, type CompactionPlan } from '../src/fold';
import { RecordBodySchema, type OpenedRecord, type RecordBody } from '../src/records';
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

  it('writes one identical snapshot per dedupe tag, deletes on the last', () => {
    const l = [
      put(1, ev('a'), 't1'),
      put(2, ev('a', { notes: 'x' }), 't2'),
      put(3, ev('a'), 't1'),
      patch(4, 'a', { name: 'edited' }),
    ];
    const plans = planCompaction(l);
    expect(plans.map((p) => p.write.dedupe)).toEqual(['t1', 't2']);
    expect(plans[0]!.deleteSeqs).toEqual([]);
    expect(plans[1]!.deleteSeqs).toEqual([1, 2, 3, 4]);
    expect(plans[0]!.write.body).toEqual(plans[1]!.write.body);
    const expected = fold(l);
    const written = plans.map((p, i) => rec(10 + i, p.write.body, p.write.dedupe));
    expect(fold(written)).toEqual(expected);
    expect(fold([...l, ...written])).toEqual(expected);
    // stopped after the first write (nothing deleted yet)
    expect(fold([...l, written[0]!])).toEqual(expected);
    // an email carrying either tag, written later, still joins the group
    for (const tag of ['t1', 't2']) {
      const later = put(20, ev('n', { name: 'later' }), tag);
      const want = fold([...l, later]);
      expect(want).toHaveLength(1);
      expect(fold([...written, later])).toEqual(want);
    }
    // and the compacted log compacts no further until it grows again
    expect(planCompaction(written)).toEqual([]);
  });

  it('does not re-compact a group with 4+ tags (one snapshot per tag)', () => {
    const l = [1, 2, 3, 4].map((i) => put(i, ev('a', { name: `n${i}` }), `t${i}`));
    const plans = planCompaction(l);
    expect(plans).toHaveLength(4);
    const written = plans.map((p, i) => rec(10 + i, p.write.body, p.write.dedupe));
    expect(planCompaction(written)).toEqual([]);
    expect(planCompaction([...l, ...written])).toHaveLength(4);
  });

  describe('groups with attachment tombstones', () => {
    const base = (): OpenedRecord[] => [
      put(1, ev('a', { attachments: [att('x'), att('y')] }), 't1'),
      patch(2, 'a', { attachments: [att('y')] }),
      patch(3, 'a', { name: 'n' }),
      patch(4, 'a', { notes: 'n' }),
    ];
    /** compacts, then returns [log with deletes applied, log with snapshots only added] */
    const compact = (l: OpenedRecord[], min = 4) => {
      const plans = planCompaction(l, min);
      return { plans, after: applyPlans(l, plans, true), both: applyPlans(l, plans, false) };
    };

    it('compacts them and the snapshot carries the tombstones', () => {
      const l = base();
      const { plans, after, both } = compact(l);
      expect(plans).toHaveLength(1);
      expect(fold(after)).toEqual(fold(l));
      expect(fold(both)).toEqual(fold(l));
      expect(fold(l)[0]!.attachments.map((a) => a.id)).toEqual(['y']);
    });

    it('a later email put re-listing the removed attachment stays removed after compaction', () => {
      const { after } = compact(base());
      const email = put(99, ev('a', { attachments: [att('x'), att('z')] }), 't1');
      const l = [...base(), email];
      expect(fold([...after, email])).toEqual(fold(l));
      expect(fold([...after, email])[0]!.attachments.map((a) => a.id)).toEqual(['y', 'z']);
    });

    it('a later patch re-adding it lifts the tombstone', () => {
      const { after } = compact(base());
      const later = [
        patch(98, 'a', { attachments: [att('x'), att('y')] }),
        put(99, ev('a', { attachments: [att('x')] }), 't1'),
      ];
      expect(fold([...after, ...later])).toEqual(fold([...base(), ...later]));
      expect(
        fold([...after, ...later])[0]!
          .attachments.map((a) => a.id)
          .sort(),
      ).toEqual(['x', 'y']);
    });

    it('tombstones survive re-compaction', () => {
      const l = base();
      const { after } = compact(l);
      const more = [
        patch(50, 'a', { name: 'm1' }),
        patch(51, 'a', { name: 'm2' }),
        patch(52, 'a', { name: 'm3' }),
      ];
      const { after: after2 } = compact([...after, ...more]);
      const email = put(99, ev('a', { attachments: [att('x')] }), 't1');
      expect(fold([...after2, email])).toEqual(fold([...l, ...more, email]));
    });

    it('multi-tag groups carry the tombstones on every snapshot', () => {
      const l = [
        put(1, ev('a', { attachments: [att('x')] }), 't1'),
        put(2, ev('a', { attachments: [att('x')] }), 't2'),
        patch(3, 'a', { attachments: [] }),
        patch(4, 'a', { name: 'n' }),
      ];
      const { plans, after, both } = compact(l);
      expect(plans).toHaveLength(2);
      expect(fold(after)).toEqual(fold(l));
      expect(fold(both)).toEqual(fold(l));
      for (const tag of ['t1', 't2']) {
        const email = put(99, ev('a', { attachments: [att('x')] }), tag);
        expect(fold([...after, email]), tag).toEqual(fold([...l, email]));
      }
    });

    it('sibling events sharing an attachment stay separate, also for old clients', () => {
      const mk = (id: string, tag: string, s: number) => [
        put(s, ev(id, { name: id, attachments: [att('src')] }), tag),
        patch(s + 1, id, { attachments: [] }),
        patch(s + 2, id, { notes: `n${id}` }),
        patch(s + 3, id, { name: `${id}!` }),
      ];
      const l = [...mk('a', 'ta', 1), ...mk('b', 'tb', 10)];
      const plans = planCompaction(l);
      expect(plans).toHaveLength(2);
      const after = applyPlans(l, plans, true);
      expect(fold(after)).toEqual(fold(l));
      expect(fold(after)).toHaveLength(2);
      expect(
        legacyFold(after)
          .map((e) => e.name)
          .sort(),
      ).toEqual(['a!', 'b!']);
      expect(legacyFold(after)).toHaveLength(2);
    });

    it('a second pass yields no plans', () => {
      const { after, both } = compact(base());
      expect(planCompaction(after)).toEqual([]);
      expect(planCompaction(after, 1)).toEqual([]);
      expect(planCompaction(both).length).toBeGreaterThan(0); // originals still present
    });

    it('stays readable by the old strict schema (tombstones are plain aliases)', () => {
      const { plans } = compact(base());
      for (const p of plans) expect(RecordBodySchema.safeParse(p.write.body).success).toBe(true);
      const body = plans[0]!.write.body;
      expect(body.kind === 'put' && body.compaction?.aliases).toEqual([`${TOMBSTONE_PREFIX}a:x`]);
    });

    it('groups without tombstones keep their old snapshot shape', () => {
      const l = [1, 2, 3, 4].map((i) => put(i, ev('a', { name: `n${i}` })));
      const body = planCompaction(l)[0]!.write.body;
      expect(body.kind === 'put' && body.compaction?.aliases).toEqual([]);
    });
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

describe('attachment tombstones', () => {
  const base = [put(1, ev('a', { attachments: [att('x'), att('y')] }), 't')];
  it('an email put cannot re-add an attachment a patch removed', () => {
    const l = [
      ...base,
      patch(2, 'a', { attachments: [att('y')] }),
      put(3, ev('a2', { attachments: [att('x'), att('z')] }), 't'),
    ];
    expect(fold(l)[0]!.attachments.map((a) => a.id)).toEqual(['y', 'z']);
  });
  it('a later patch can re-add it, and then emails may list it again', () => {
    const l = [
      ...base,
      patch(2, 'a', { attachments: [att('y')] }),
      patch(3, 'a', { attachments: [att('x'), att('y')] }),
      put(4, ev('a', { attachments: [att('x')] }), 't'),
    ];
    expect(fold(l)[0]!.attachments.map((a) => a.id)).toEqual(['x', 'y']);
  });
  it('a put before the patch is unaffected', () => {
    const l = [
      ...base,
      put(2, ev('a', { attachments: [att('w')] }), 't'),
      patch(3, 'a', { attachments: [att('w')] }),
    ];
    expect(fold(l)[0]!.attachments.map((a) => a.id)).toEqual(['w']);
  });
});

describe('patches that clear fields (null)', () => {
  it('null removes an optional field and pins it against emails', () => {
    const l = [
      put(
        1,
        ev('a', {
          notes: 'n',
          confirmation: 'C',
          start: { local: '2026-06-01T10:00', tz: 'Europe/Paris' },
        }),
      ),
      patch(2, 'a', { notes: null, start: null }),
      put(3, ev('a', { notes: 'again', start: { local: '2026-06-02T10:00', tz: 'Europe/Paris' } })),
    ];
    const [e] = fold(l);
    expect(e).toEqual(ev('a', { confirmation: 'C', pinned: ['notes', 'start'] }));
    expect('notes' in e!).toBe(false);
  });
  it('is allowed only on optional fields', () => {
    const body = (fields: unknown) => ({ kind: 'patch', target: 'a', fields });
    expect(
      RecordBodySchema.safeParse(body({ location: null, endLocation: null, notes: null })).success,
    ).toBe(true);
    for (const f of [
      'name',
      'type',
      'attachments',
      'participants',
      'status',
      'deleted',
      'pinned',
    ]) {
      expect(RecordBodySchema.safeParse(body({ [f]: null })).success, f).toBe(false);
    }
  });
});

describe('late bridges are not retroactive', () => {
  it('a patch written before its target id existed stays ignored after a bridging put', () => {
    const l = [
      put(1, ev('a', { name: 'A' }), 't'),
      patch(2, 'x', { name: 'too early' }),
      del(3, 'x'),
      put(4, ev('x', { name: 'X' }), 't'), // bridges: same tag as a
    ];
    expect(fold(l)).toEqual([ev('a', { name: 'X' })]);
  });
  it('a patch to an id written after its put still applies in the merged group', () => {
    const l = [
      put(1, ev('a', { name: 'A' }), 't1'),
      put(2, ev('b', { name: 'B' }), 't2'),
      patch(3, 'b', { notes: 'mine' }),
      put(4, ev('b', { name: 'B2' }), 't1'),
    ];
    expect(fold(l)).toEqual([ev('a', { name: 'B2', notes: 'mine', pinned: ['notes'] })]);
  });
});

describe('compaction races and aliases', () => {
  const base = [
    put(1, ev('a', { name: 'orig' }), 't'),
    put(2, ev('b', { notes: 'n' }), 't'),
    patch(3, 'a', { notes: 'p1' }),
    patch(4, 'b', { needsReview: true }),
  ];
  const compactedPut = (log: OpenedRecord[], seq: number) => {
    const [p] = planCompaction(log);
    return { rec: rec(seq, p!.write.body, p!.write.dedupe), plan: p! };
  };

  it('a patch written between plan and write survives compaction', () => {
    const { rec: c, plan } = compactedPut(base, 6);
    const concurrent = patch(5, 'a', { name: 'USER EDIT' });
    const expected = fold([...base, concurrent]);
    expect(expected[0]!.name).toBe('USER EDIT');
    const after = [concurrent, c]; // seqs 1-4 deleted
    expect(plan.deleteSeqs).toEqual([1, 2, 3, 4]);
    expect(fold(after)).toEqual(expected);
    expect(fold([...base, ...after])).toEqual(expected);
  });

  it('a patch to an alias still resolves after compaction', () => {
    const { rec: c } = compactedPut(base, 6);
    const stale = patch(7, 'b', { name: 'via alias' });
    const [e] = fold([c, stale]);
    expect(e!.id).toBe('a');
    expect(e!.name).toBe('via alias');
    expect(fold([c, del(8, 'b')])).toEqual([]);
  });

  it('a compacted group keeps its canonical id when a later put bridges another group', () => {
    const { rec: c } = compactedPut(base, 10);
    const other = put(7, ev('z', { name: 'z' }), 'u');
    const bridge = put(11, ev('z', { name: 'bridged' }), 't');
    const [e] = fold([c, other, bridge]);
    // the compacted group counts as seq 1 (its firstSeq), earlier than z's seq 7
    expect(e!.id).toBe('a');
  });

  it('re-compaction carries firstSeq and aliases forward', () => {
    const { rec: c1 } = compactedPut(base, 6);
    const more = [
      c1,
      patch(7, 'b', { name: 'two' }),
      put(8, ev('c', { notes: 'later' }), 't'),
      patch(9, 'a', { type: 'dining' }),
    ];
    const before = fold(more);
    const [p2] = planCompaction(more);
    expect(p2!.deleteSeqs).toEqual([6, 7, 8, 9]);
    const body = p2!.write.body;
    expect(body.kind === 'put' && body.compaction).toEqual({
      firstSeq: 1,
      throughSeq: 9,
      aliases: ['b', 'c'],
    });
    const c2 = rec(12, p2!.write.body, p2!.write.dedupe);
    expect(fold([c2])).toEqual(before);
    expect(fold([c2, patch(13, 'c', { name: 'alias after 2nd' })])[0]!.name).toBe(
      'alias after 2nd',
    );
  });

  it('a snapshot overrides pins and sources of older records still present', () => {
    const log = [
      put(1, ev('a', { name: 'x' }), 't'),
      patch(2, 'a', { name: 'mine' }),
      put(3, ev('a', { name: 'email' }), 't'),
      put(4, ev('a', { notes: 'q' }), 't'),
    ];
    const { rec: c } = compactedPut(log, 9);
    expect(fold([...log, c])).toEqual(fold(log));
  });

  it('the compaction marker round-trips through the record schema', () => {
    const { plan } = compactedPut(base, 6);
    expect(RecordBodySchema.parse(JSON.parse(JSON.stringify(plan.write.body)))).toEqual(
      plan.write.body,
    );
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

/** Fisher-Yates with a PRNG created once by the caller. */
function shuffle<T>(xs: T[], r: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const IDS = ['a', 'b', 'c', 'd', 'e', 'f'];
const TAGS = ['t1', 't2', 't3', null, null];

/**
 * Random records with seqs from `startSeq`. When `existing` is given, puts never bridge
 * existing groups: they reuse the (id, tag) pair of an existing put or use fresh ones.
 * Bridging after compaction (a late put joining a compacted group to another) is a documented limitation (CONTRACTS.md section 3).
 */
function randomRecords(
  r: () => number,
  tagPrefix: string,
  startSeq: number,
  n: number,
  existing: OpenedRecord[] | null,
): OpenedRecord[] {
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const log: OpenedRecord[] = [];
  const puts = existing ? existing.filter((x) => x.body.kind === 'put') : [];
  const idOf = (x: OpenedRecord): string => (x.body.kind === 'put' ? x.body.event.id : '');
  let fresh = 0;
  for (let i = 0; i < n; i++) {
    const seq = startSeq + i * 3;
    const k = r();
    if (k < 0.55) {
      let id = pick(IDS);
      let tag = pick(TAGS);
      if (existing) {
        if (puts.length > 0 && r() < 0.7) {
          const src = pick(puts);
          id = idOf(src);
          tag = src.dedupe;
        } else {
          id = `${tagPrefix}-${fresh}`;
          tag = r() < 0.5 ? `${tagPrefix}-t${fresh}` : null;
          fresh++;
        }
      }
      const e: Event = ev(id, {
        name: `n${Math.floor(r() * 5)}`,
        status: pick(['confirmed', 'cancelled']),
        source: pick(['email', 'email', 'manual']),
        attachments: r() < 0.5 ? [att(pick(['x', 'y', 'z']))] : [],
      });
      if (r() < 0.5) e.notes = `note${Math.floor(r() * 3)}`;
      if (r() < 0.3) e.start = { local: '2026-06-01T10:00', tz: 'Europe/Paris' };
      if (r() < 0.2) e.pinned = [pick(['notes', 'name', 'attachments'])];
      const p = put(seq, e, tag);
      if (existing) puts.push(p);
      log.push(p);
    } else {
      const ids = existing ? puts.map(idOf) : IDS;
      const target = pick([...ids, 'ghost']);
      if (k < 0.9) {
        const fields: Record<string, unknown> = {};
        if (r() < 0.5) fields.name = `p${Math.floor(r() * 5)}`;
        if (r() < 0.4) fields.notes = `pn${Math.floor(r() * 3)}`;
        if (r() < 0.3) fields.status = pick(['confirmed', 'cancelled']);
        if (r() < 0.3) fields.attachments = [att(pick(['x', 'y', 'w']))];
        if (r() < 0.1) fields.deleted = false;
        if (r() < 0.15) fields.notes = null;
        if (r() < 0.1) fields.start = null;
        log.push(patch(seq, target, fields));
      } else {
        log.push(del(seq, target));
      }
    }
  }
  return log;
}

const maxSeq = (log: OpenedRecord[]): number => Math.max(0, ...log.map((l) => l.seq));

/** Applies plans: writes land at fresh seqs after everything; deletes are optional. */
function applyPlans(log: OpenedRecord[], plans: CompactionPlan[], withDeletes: boolean) {
  const gone = new Set(withDeletes ? plans.flatMap((p) => p.deleteSeqs) : []);
  let seq = maxSeq(log) + 1;
  return [
    ...log.filter((l) => !gone.has(l.seq)),
    ...plans.map((p) => rec(seq++, p.write.body, p.write.dedupe)),
  ];
}

describe('fold properties', () => {
  it('200 random logs: compaction, concurrent writes, later writes and shuffling never change the result', () => {
    let compacted = 0;
    let recompacted = 0;
    let withTombs = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = prng(seed);
      const ctx = `seed ${seed}`;
      const log = randomRecords(r, `s${seed}`, 3, 1 + Math.floor(r() * 30), null);
      const plans = planCompaction(log, 2 + (seed % 3));
      if (plans.length > 0) compacted++;
      if (
        plans.some(
          (p) =>
            p.write.body.kind === 'put' &&
            p.write.body.compaction?.aliases.some((a) => a.startsWith(TOMBSTONE_PREFIX)),
        )
      )
        withTombs++;
      expect(fold(shuffle(log, r)), ctx).toEqual(fold(log));

      // (a) concurrent writes land between planning and writing the compacted puts
      const concurrent = randomRecords(r, `c${seed}`, maxSeq(log) + 3, Math.floor(r() * 6), log);
      const full = [...log, ...concurrent];
      const gone = new Set(plans.flatMap((p) => p.deleteSeqs));
      const kept = [...log.filter((l) => !gone.has(l.seq)), ...concurrent];
      const written = applyPlans(
        [...log, ...concurrent],
        plans.map((p) => ({ ...p, deleteSeqs: [] })),
        false,
      ).slice(full.length);
      const withDeletes = [...kept, ...written];
      expect(fold(withDeletes), ctx).toEqual(fold(full));
      expect(fold([...full, ...written]), ctx).toEqual(fold(full));
      expect(fold(shuffle(withDeletes, r)), ctx).toEqual(fold(full));

      // (b) keep appending after compaction, compare against the uncompacted log
      const later = randomRecords(
        r,
        `l${seed}`,
        maxSeq(withDeletes) + 3,
        1 + Math.floor(r() * 10),
        full,
      );
      const expected = fold([...full, ...later]);
      expect(fold([...withDeletes, ...later]), ctx).toEqual(expected);

      // compact the compacted log again
      const plans2 = planCompaction([...withDeletes, ...later], 2);
      if (plans2.length > 0) recompacted++;
      expect(fold(applyPlans([...withDeletes, ...later], plans2, true)), ctx).toEqual(expected);
      expect(fold(applyPlans([...withDeletes, ...later], plans2, false)), ctx).toEqual(expected);
    }
    expect(compacted).toBeGreaterThan(50);
    expect(recompacted).toBeGreaterThan(50);
    expect(withTombs).toBeGreaterThan(20);
  });
});

describe('compaction marker schema', () => {
  it('rejects firstSeq > throughSeq', async () => {
    const { RecordBodySchema } = await import('../src/records');
    const event = fold([put(1, ev('a'))])[0];
    const body = { kind: 'put', event, compaction: { firstSeq: 5, throughSeq: 4, aliases: [] } };
    expect(RecordBodySchema.safeParse(body).success).toBe(false);
    body.compaction.firstSeq = 4;
    expect(RecordBodySchema.safeParse(body).success).toBe(true);
  });
});
