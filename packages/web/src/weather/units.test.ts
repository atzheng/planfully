import { expect, test } from 'vitest';
import { defaultSystem, isUnitSystem, unitsFor } from './units';

test('unit systems map to temp and wind units', () => {
  expect(unitsFor('imperial')).toEqual({ temp: 'F', wind: 'mph' });
  expect(unitsFor('metric')).toEqual({ temp: 'C', wind: 'kmh' });
});

test('locale default: US imperial, UK and France metric', () => {
  expect(defaultSystem('en-US')).toBe('imperial');
  expect(defaultSystem('en-GB')).toBe('metric');
  expect(defaultSystem('fr-FR')).toBe('metric');
  expect(isUnitSystem('imperial')).toBe(true);
  expect(isUnitSystem('kelvin')).toBe(false);
});
