import { describe, expect, test } from 'vitest';
import type { Event } from '@planfully/shared';
import { buildFields, initialValues } from './formModel';

function build(over: Partial<ReturnType<typeof initialValues>>, orig: Partial<Event>) {
  return buildFields({ ...initialValues(orig), ...over }, orig);
}

describe('location coordinates', () => {
  const point: Partial<Event> = { type: 'attraction', location: { lat: 1.5, lng: 2.5 } };

  test('a bare map point keeps its coordinates and needs only a name', () => {
    const r = build({ name: 'Viewpoint' }, point);
    expect(r.ok && r.fields.location).toEqual({ lat: 1.5, lng: 2.5 });
  });

  test('naming a bare map point keeps its coordinates', () => {
    const r = build({ name: 'Viewpoint', locationName: 'Mirador' }, point);
    expect(r.ok && r.fields.location).toEqual({ name: 'Mirador', lat: 1.5, lng: 2.5 });
  });

  test('a picked place replaces the old coordinates', () => {
    const r = build(
      {
        name: 'x',
        locationName: 'Orly',
        locationAddress: 'Orly, France',
        locationGeo: { lat: 48.7, lng: 2.4, placeId: 'p' },
      },
      { location: { name: 'CDG', lat: 49, lng: 2 } },
    );
    expect(r.ok && r.fields.location).toEqual({
      name: 'Orly',
      address: 'Orly, France',
      lat: 48.7,
      lng: 2.4,
      placeId: 'p',
    });
  });

  test('a new event without a name is refused', () => {
    expect(build({ name: '' }, point).ok).toBe(false);
  });
});
