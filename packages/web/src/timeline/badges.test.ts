import type { RosterMember } from '@planfully/shared';
import { expect, test } from 'vitest';
import { badgePlacement, participantBadges, MAX_BADGES } from './badges';

const base = {
  tier: 'full' as const,
  widthPx: 300,
  heightPx: 80,
  titleChars: 10,
  count: 2,
  laneMode: 'none' as const,
  textRows: 1,
};

test('inline when title and badges fit', () => {
  expect(badgePlacement(base)).toEqual({ where: 'inline', shown: 2, more: 0 });
});

test('below when the title leaves no room, and the block is tall enough', () => {
  expect(badgePlacement({ ...base, widthPx: 150, titleChars: 16, heightPx: 90 })).toMatchObject({
    where: 'below',
  });
});

test('full block too short for an extra row falls back to hidden', () => {
  expect(badgePlacement({ ...base, widthPx: 150, titleChars: 16, heightPx: 44 })).toEqual({
    where: 'hidden',
    shown: 0,
    more: 0,
  });
});

test('caps at three badges and counts the rest in +N', () => {
  expect(badgePlacement({ ...base, count: 5 })).toEqual({
    where: 'inline',
    shown: MAX_BADGES,
    more: 2,
  });
});

test('below row collapses to fewer badges plus +N when narrow', () => {
  const p = badgePlacement({ ...base, widthPx: 80, titleChars: 12, count: 3, heightPx: 90 });
  expect(p.where).toBe('below');
  expect(p.shown + p.more).toBe(3);
  expect(p.shown).toBeLessThan(3);
  expect(p.more).toBeGreaterThan(0);
});

test('line tier: inline when there is room, otherwise hidden', () => {
  expect(badgePlacement({ ...base, tier: 'line', heightPx: 20, textRows: 0 }).where).toBe('inline');
  expect(
    badgePlacement({
      ...base,
      tier: 'line',
      heightPx: 20,
      textRows: 0,
      widthPx: 150,
      titleChars: 16,
    }).where,
  ).toBe('hidden');
});

test('hidden for lanes by participant, bars, icon-only, no participants', () => {
  expect(badgePlacement({ ...base, laneMode: 'participant' }).where).toBe('hidden');
  expect(badgePlacement({ ...base, tier: 'bar' }).where).toBe('hidden');
  expect(badgePlacement({ ...base, widthPx: 50 }).where).toBe('hidden');
  expect(badgePlacement({ ...base, count: 0 }).where).toBe('hidden');
  expect(badgePlacement({ ...base, laneMode: 'type' }).where).toBe('inline');
});

test('reserved width pushes badges below', () => {
  const args = { ...base, widthPx: 190, titleChars: 12, heightPx: 90 };
  expect(badgePlacement(args).where).toBe('inline');
  expect(badgePlacement({ ...args, reservedPx: 40 }).where).toBe('below');
});

test('participantBadges: stable roster colour, neutral for unknown, none for everyone', () => {
  const roster: RosterMember[] = [
    { id: 'a', name: 'Ann Lee', aliases: [] },
    { id: 'b', name: 'Bob', aliases: [] },
  ];
  expect(participantBadges([], roster)).toEqual([]);
  expect(participantBadges(['b', 'zed', 'b', 'a'], roster)).toEqual([
    { label: 'B', tone: 2, name: 'Bob' },
    { label: 'Z', tone: 'neutral', name: null },
    { label: 'AL', tone: 1, name: 'Ann Lee' },
  ]);
});
