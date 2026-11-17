import { describe, expect, test } from 'vitest';
import type { Event } from '@planfully/shared';
import { buildFields, buildLocalTime, defaultZones, diffFields, initialValues } from './formModel';

const base: Event = {
  id: 'e1',
  name: 'Flight to Lisbon',
  type: 'flight',
  start: { local: '2026-07-14T09:30', tz: 'Europe/Paris' },
  end: { local: '2026-07-14T11:00', tz: 'Europe/Lisbon' },
  confirmation: 'XYZ789',
  location: { name: 'CDG', address: 'Paris', lat: 49, lng: 2 },
  attachments: [],
  participants: ['a'],
  status: 'confirmed',
  notes: 'aisle',
  source: 'email',
  createdAt: '2026-07-01T00:00:00.000Z',
};

function build(over: Partial<ReturnType<typeof initialValues>>, orig: Partial<Event> = base) {
  return buildFields({ ...initialValues(orig), ...over }, orig);
}

describe('diffFields', () => {
  test('unchanged form yields an empty patch', () => {
    const r = build({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(diffFields(base, r.fields)).toEqual({});
  });

  test('only the changed field is in the patch', () => {
    const r = build({ startTime: '10:15' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(diffFields(base, r.fields)).toEqual({
        start: { local: '2026-07-14T10:15', tz: 'Europe/Paris' },
      });
    }
  });

  test('participant order does not count as a change', () => {
    const orig = { ...base, participants: ['a', 'b'] };
    const r = build({ participants: ['b', 'a'] }, orig);
    expect(r.ok).toBe(true);
    if (r.ok) expect(diffFields(orig, r.fields)).toEqual({});
  });

  test('changed location text drops coordinates', () => {
    const r = build({ locationName: 'Orly' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(diffFields(base, r.fields)).toEqual({ location: { name: 'Orly', address: 'Paris' } });
    }
  });

  test('confirmation and notes can be blanked with an empty string', () => {
    const r = build({ confirmation: '', notes: '' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(diffFields(base, r.fields)).toEqual({ confirmation: '', notes: '' });
  });
});

describe('buildFields validation', () => {
  test('name is required', () => {
    const r = build({ name: '  ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.name).toBeTruthy();
  });

  test('end before start is an error on end', () => {
    const r = build({ endDate: '2026-07-13', endTz: 'Europe/Paris' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.endDate).toMatch(/before/);
  });

  test('end is compared by instant across zones', () => {
    // Start 11:30 Paris = 10:30 Lisbon, so an end of 10:00 Lisbon is earlier.
    const r = build({ startTime: '11:30', endTime: '10:00' });
    expect(r.ok).toBe(false);
  });

  test('a time that was set cannot be removed', () => {
    const r = build({ startDate: '', startTime: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.startDate).toMatch(/cannot be removed/);
  });

  test('half-filled time and bad zone are errors', () => {
    expect(buildLocalTime('2026-07-14', '', 'UTC').error).toBeTruthy();
    expect(buildLocalTime('', '10:00', 'UTC').error).toBeTruthy();
    expect(buildLocalTime('2026-07-14', '10:00', 'Not/AZone').error).toBeTruthy();
  });

  test('new event with no times is fine', () => {
    const r = buildFields(initialValues({ name: 'Idea', type: 'activity' }), {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fields).toEqual({
        name: 'Idea',
        type: 'activity',
        status: 'confirmed',
        participants: [],
      });
    }
  });
});

describe('untrimmed originals and DST gaps', () => {
  const messy: Event = {
    ...base,
    name: 'Hotel ',
    confirmation: ' C1',
    notes: 'n ',
    location: { name: ' Inn', address: 'Rua ', lat: 1, lng: 2, placeId: 'p' },
  };

  test('an unedited form produces an empty patch and keeps coordinates', () => {
    const r = buildFields(initialValues(messy), messy);
    expect(r.ok).toBe(true);
    if (r.ok) expect(diffFields(messy, r.fields)).toEqual({});
  });

  test('a real location edit still replaces it', () => {
    const r = buildFields({ ...initialValues(messy), locationName: 'Other' }, messy);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(diffFields(messy, r.fields).location).toEqual({ name: 'Other', address: 'Rua' });
  });

  test('a time in a DST gap is rejected', () => {
    expect(buildLocalTime('2026-03-08', '02:30', 'America/New_York').error).toMatch(
      /does not exist/,
    );
    expect(buildLocalTime('2026-03-08', '03:30', 'America/New_York').error).toBeUndefined();
  });
});

describe('defaultZones', () => {
  test('event zone, then other time, then fallback, then browser', () => {
    expect(defaultZones({ start: base.start, end: base.end })).toEqual({
      startTz: 'Europe/Paris',
      endTz: 'Europe/Lisbon',
    });
    expect(defaultZones({ end: base.end }).startTz).toBe('Europe/Lisbon');
    expect(defaultZones({}, 'Asia/Tokyo')).toEqual({ startTz: 'Asia/Tokyo', endTz: 'Asia/Tokyo' });
    expect(defaultZones({}).startTz).toBeTruthy();
  });
});
