import { describe, expect, test } from 'vitest';
import type { Event } from '@planfully/shared';
import { boundsKey, boundsOf, buildMapModel, locatedEvents, SPREAD_DEG } from './markers';

const mk = (id: string, over: Partial<Event> = {}): Event => ({
  id,
  name: id,
  type: 'activity',
  attachments: [],
  participants: [],
  status: 'confirmed',
  source: 'manual',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('buildMapModel', () => {
  test('one marker per located event; unlocated and lat-only are skipped', () => {
    const m = buildMapModel([
      mk('a', { location: { lat: 1, lng: 2 } }),
      mk('b'),
      mk('c', { location: { name: 'x', lat: 3 } }),
    ]);
    expect(m.markers).toHaveLength(1);
    expect(m.markers[0]).toMatchObject({
      eventId: 'a',
      lat: 1,
      lng: 2,
      type: 'activity',
      label: 'a',
    });
    expect(m.paths).toEqual([]);
  });

  test('transport with both ends gives two markers and a path', () => {
    const m = buildMapModel([
      mk('f', {
        type: 'flight',
        location: { lat: 10, lng: 20 },
        endLocation: { lat: 30, lng: 40 },
      }),
    ]);
    expect(m.markers.map((k) => k.role)).toEqual(['start', 'end']);
    expect(m.paths).toEqual([
      { eventId: 'f', type: 'flight', from: { lat: 10, lng: 20 }, to: { lat: 30, lng: 40 } },
    ]);
  });

  test('transport with one end has no path; non-transport ignores endLocation', () => {
    const m = buildMapModel([
      mk('t', { type: 'train', endLocation: { lat: 5, lng: 6 } }),
      mk('d', { type: 'dining', location: { lat: 1, lng: 1 }, endLocation: { lat: 2, lng: 2 } }),
    ]);
    expect(m.paths).toEqual([]);
    expect(m.markers.map((k) => `${k.eventId}:${k.role}`)).toEqual(['t:end', 'd:start']);
  });

  test('identical coordinates are offset, distinct ones untouched', () => {
    const m = buildMapModel([
      mk('a', { location: { lat: 40, lng: -3 } }),
      mk('b', { location: { lat: 40, lng: -3 } }),
      mk('c', { location: { lat: 41, lng: -3 } }),
    ]);
    const [a, b, c] = m.markers;
    expect(a).toBeDefined();
    expect(a?.lat === b?.lat && a?.lng === b?.lng).toBe(false);
    expect(Math.abs((a?.lat ?? 0) - 40)).toBeLessThanOrEqual(SPREAD_DEG + 1e-9);
    expect(c).toMatchObject({ lat: 41, lng: -3 });
    // bounds use the real coordinates
    expect(m.bounds).toEqual({ north: 41, south: 40, east: -3, west: -3 });
  });

  test('empty input', () => {
    expect(buildMapModel([])).toEqual({ markers: [], paths: [], bounds: null });
  });
});

describe('helpers', () => {
  test('boundsOf and boundsKey', () => {
    expect(boundsOf([])).toBeNull();
    const b = boundsOf([
      { lat: 1, lng: 5 },
      { lat: -2, lng: 7 },
    ]);
    expect(b).toEqual({ north: 1, south: -2, east: 7, west: 5 });
    expect(boundsKey(b)).toBe('1,-2,7,5');
    expect(boundsKey(null)).toBe('');
  });

  test('locatedEvents', () => {
    const es = [
      mk('a', { location: { lat: 1, lng: 2 } }),
      mk('b'),
      mk('c', { type: 'bus', endLocation: { lat: 1, lng: 2 } }),
    ];
    expect(locatedEvents(es).map((e) => e.id)).toEqual(['a', 'c']);
  });
});
