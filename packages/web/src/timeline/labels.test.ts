import { expect, test } from 'vitest';
import {
  axisHourLabel,
  dayHeadingParts,
  localEndLabel,
  localTimeRange,
  placeLabel,
} from './labels';

const ev = {
  start: { local: '2026-07-14T09:30', tz: 'Europe/Lisbon' },
  end: { local: '2026-07-14T11:00', tz: 'Europe/Lisbon' },
  location: { name: 'Pasteis de Belem', address: 'R. de Belem 84, Lisboa' },
};

test('block time range and place are event-local text', () => {
  expect(localEndLabel(ev)).toBe('11:00');
  expect(localTimeRange(ev)).toBe('09:30–11:00');
  expect(localTimeRange({ start: ev.start })).toBe('09:30');
  expect(localTimeRange({})).toBe('');
  expect(placeLabel(ev)).toBe('Pasteis de Belem');
  expect(placeLabel({ location: { address: 'R. de Belem 84, Lisboa' } })).toBe('R. de Belem 84');
  expect(placeLabel({})).toBe('');
});

test('axis hour labels, 12h and 24h', () => {
  expect(axisHourLabel(Date.UTC(2026, 6, 14, 12), 'UTC', true)).toBe('12p');
  expect(axisHourLabel(Date.UTC(2026, 6, 14, 9), 'UTC', true)).toBe('9a');
  expect(axisHourLabel(Date.UTC(2026, 6, 14, 0, 0), 'UTC', true)).toBe('12a');
  expect(axisHourLabel(Date.UTC(2026, 6, 14, 14), 'UTC', false)).toBe('14:00');
});

test('day heading parts', () => {
  expect(dayHeadingParts(Date.UTC(2026, 6, 14, 12), 'UTC')).toEqual({
    weekday: 'Tue',
    rest: '14 Jul',
  });
});
