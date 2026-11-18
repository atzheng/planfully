import { describe, expect, test } from 'vitest';
import { latLngAtPixel } from './pointAt';

describe('latLngAtPixel', () => {
  const size = { width: 400, height: 300 };
  test('the container centre is the map centre', () => {
    const p = latLngAtPixel({ lat: 38.7, lng: -9.1 }, 12, size, 200, 150);
    expect(p.lat).toBeCloseTo(38.7, 6);
    expect(p.lng).toBeCloseTo(-9.1, 6);
  });
  test('right and down move east and south', () => {
    const c = { lat: 10, lng: 20 };
    const p = latLngAtPixel(c, 10, size, 300, 250);
    expect(p.lng).toBeGreaterThan(20);
    expect(p.lat).toBeLessThan(10);
  });
  test('one tile at zoom 0 is the whole world', () => {
    const p = latLngAtPixel({ lat: 0, lng: 0 }, 0, { width: 256, height: 256 }, 256, 128);
    expect(Math.abs(p.lng)).toBeCloseTo(180, 6);
  });
  test('longitude wraps into range', () => {
    const p = latLngAtPixel({ lat: 0, lng: 179 }, 2, size, 400, 150);
    expect(p.lng).toBeGreaterThanOrEqual(-180);
    expect(p.lng).toBeLessThanOrEqual(180);
  });
});
