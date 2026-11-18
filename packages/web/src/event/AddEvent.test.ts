import { describe, expect, test } from 'vitest';
import { defaultStart, pointDraft } from './AddEvent';

describe('defaultStart', () => {
  test('is the centre time in the timeline zone, rounded down to 15 minutes', () => {
    const ms = Date.parse('2026-07-14T10:37:20Z');
    expect(defaultStart({ ms, tz: 'Europe/Lisbon' })).toEqual({
      local: '2026-07-14T11:30',
      tz: 'Europe/Lisbon',
    });
  });
  test('is nothing without a centre (map view)', () => {
    expect(defaultStart(null)).toBeUndefined();
    expect(defaultStart({ ms: NaN, tz: 'UTC' })).toBeUndefined();
  });
});

describe('pointDraft', () => {
  test('is an attraction with only a location', () => {
    expect(pointDraft(1, 2)).toEqual({ type: 'attraction', location: { lat: 1, lng: 2 } });
  });
});
