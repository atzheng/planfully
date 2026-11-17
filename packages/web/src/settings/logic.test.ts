import { expect, test } from 'vitest';
import type { Event, RosterMember } from '@planfully/shared';
import {
  addMember,
  addSender,
  countReferences,
  isValidEmail,
  parseAliases,
  removeMember,
  removeSender,
  rosterError,
  updateMember,
} from './logic';

const R: RosterMember[] = [
  { id: 'a', name: 'Ann', aliases: [] },
  { id: 'b', name: 'Bo', aliases: ['B'] },
];

test('isValidEmail', () => {
  expect(isValidEmail('a@b.co')).toBe(true);
  for (const bad of ['', 'a', 'a@b', 'a@@b.co', 'a b@c.co', 'a@b..co', '@b.co'])
    expect(isValidEmail(bad)).toBe(false);
});

test('addSender lowercases, trims, dedupes, rejects invalid', () => {
  expect(addSender([], ' A@X.com ')).toEqual({ ok: true, senders: ['a@x.com'] });
  expect(addSender(['a@x.com'], 'A@x.com')).toEqual({ ok: true, senders: ['a@x.com'] });
  expect(addSender([], 'nope').ok).toBe(false);
  expect(addSender([], ' ').ok).toBe(false);
  expect(removeSender(['a@x.com', 'b@x.com'], 'a@x.com')).toEqual(['b@x.com']);
});

test('addMember assigns a new id; rename keeps id', () => {
  const r = addMember(R, ' Cy ', () => 'c');
  expect(r).toEqual({ ok: true, roster: [...R, { id: 'c', name: 'Cy', aliases: [] }] });
  expect(addMember(R, '  ', () => 'c').ok).toBe(false);
  const renamed = updateMember(R, 'a', { name: 'Anna', aliases: ['An'] });
  expect(renamed[0]).toEqual({ id: 'a', name: 'Anna', aliases: ['An'] });
  expect(renamed[1]).toBe(R[1]);
  expect(removeMember(R, 'a').map((m) => m.id)).toEqual(['b']);
});

test('parseAliases', () => {
  expect(parseAliases(' A, B ,,A')).toEqual(['A', 'B']);
});

test('rosterError', () => {
  expect(rosterError(R)).toBeNull();
  expect(rosterError([{ id: 'x', name: ' ', aliases: [] }])).not.toBeNull();
});

test('countReferences ignores tombstones', () => {
  const ev = (participants: string[], deleted?: boolean) =>
    ({ participants, deleted }) as unknown as Event;
  expect(
    countReferences([ev(['a']), ev(['a', 'b']), ev(['b']), ev(['a'], true), ev([])], 'a'),
  ).toBe(2);
});
