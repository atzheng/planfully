import type { Event, Location } from '@planfully/shared';
import { expect, test } from 'vitest';
import { hourlyLocations, HOUR_MS } from './resolve';

let n = 0;
function ev(
  start: string | null,
  end: string | null,
  over: Partial<Event> & { location?: Location } = {},
): Event {
  n += 1;
  return {
    id: `e${n}`,
    name: `Event ${n}`,
    type: 'activity',
    ...(start ? { start: { local: start, tz: 'UTC' } } : {}),
    ...(end ? { end: { local: end, tz: 'UTC' } } : {}),
    attachments: [],
    participants: [],
    status: 'confirmed',
    source: 'manual',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}
const paris = { name: 'Paris', lat: 48.8566, lng: 2.3522 };
const rome = { name: 'Rome', lat: 41.9028, lng: 12.4964 };
const t = (iso: string) => Date.parse(`${iso}:00Z`);

test('stay in one city yields a single merged segment', () => {
  const events = [
    ev('2026-06-01T10:00', '2026-06-01T12:00', { location: paris }),
    ev('2026-06-01T19:00', '2026-06-01T21:00', { location: { ...paris, lat: 48.8569 } }),
  ];
  const segs = hourlyLocations(events, t('2026-06-01T09:00'), t('2026-06-02T00:00'));
  expect(segs).toHaveLength(1);
  expect(segs[0]).toMatchObject({ lat: 48.86, lng: 2.35, label: 'Paris' });
  expect(segs[0]?.fromMs).toBe(t('2026-06-01T09:00'));
  expect(segs[0]?.toMs).toBe(t('2026-06-02T00:00'));
});

test('travel day switches from origin to destination at departure', () => {
  const events = [
    ev('2026-06-01T09:00', '2026-06-01T10:00', { location: paris }),
    ev('2026-06-01T14:00', '2026-06-01T16:00', {
      type: 'transit',
      mode: 'flight',
      location: paris,
      endLocation: rome,
    }),
  ];
  const segs = hourlyLocations(events, t('2026-06-01T10:00'), t('2026-06-01T20:00'));
  // 10:00-13:00 still the last ended event (Paris); from departure (14:00) the destination.
  expect(segs.map((s) => [s.label, s.fromMs, s.toMs])).toEqual([
    ['Paris', t('2026-06-01T10:00'), t('2026-06-01T14:00')],
    ['Rome', t('2026-06-01T14:00'), t('2026-06-01T20:00')],
  ]);
});

test('hours before the first located event use the first upcoming one', () => {
  const events = [ev('2026-06-01T12:00', '2026-06-01T13:00', { location: rome })];
  const segs = hourlyLocations(events, t('2026-06-01T06:00'), t('2026-06-01T15:00'));
  expect(segs).toHaveLength(1);
  expect(segs[0]).toMatchObject({ label: 'Rome', fromMs: t('2026-06-01T06:00') });
});

test('cancelled, unscheduled, deleted and coordinate-less events are ignored', () => {
  const events = [
    ev('2026-06-01T08:00', '2026-06-01T20:00', { location: rome, status: 'cancelled' }),
    ev(null, null, { location: rome }),
    ev('2026-06-01T08:00', '2026-06-01T20:00', { location: rome, deleted: true }),
    ev('2026-06-01T08:00', '2026-06-01T20:00', { location: { name: 'Nowhere' } }),
    ev('2026-06-01T09:00', '2026-06-01T10:00', { location: paris }),
  ];
  const segs = hourlyLocations(events, t('2026-06-01T08:00'), t('2026-06-01T12:00'));
  expect(segs).toHaveLength(1);
  expect(segs[0]?.label).toBe('Paris');
});

test('no located events or empty range gives no segments', () => {
  expect(hourlyLocations([], 0, 10 * HOUR_MS)).toEqual([]);
  expect(hourlyLocations([ev('2026-06-01T09:00', null, { location: paris })], 5, 5)).toEqual([]);
});

test('an in-progress event beats a more recent ended one', () => {
  const events = [
    ev('2026-06-01T08:00', '2026-06-01T18:00', { location: paris }),
    ev('2026-06-01T09:00', '2026-06-01T10:00', { location: rome }),
  ];
  const segs = hourlyLocations(events, t('2026-06-01T09:00'), t('2026-06-01T12:00'));
  expect(segs.map((s) => s.label)).toEqual(['Rome', 'Paris']);
});

test('transport without endLocation falls back to its location', () => {
  const events = [
    ev('2026-06-01T09:00', '2026-06-01T11:00', { type: 'transit', mode: 'train', location: paris }),
  ];
  const segs = hourlyLocations(events, t('2026-06-01T10:00'), t('2026-06-01T13:00'));
  expect(segs).toHaveLength(1);
  expect(segs[0]?.label).toBe('Paris');
});

test('first and last segments are clamped to the requested range', () => {
  const events = [ev('2026-06-01T09:00', '2026-06-01T10:00', { location: paris })];
  const from = t('2026-06-01T09:30');
  const to = t('2026-06-01T12:15');
  const segs = hourlyLocations(events, from, to);
  expect(segs[0]?.fromMs).toBe(from);
  expect(segs[segs.length - 1]?.toMs).toBe(to);
});
