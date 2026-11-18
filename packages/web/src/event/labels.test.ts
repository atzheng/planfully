import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, TRANSIT_MODES } from '@planfully/shared';
import {
  capitalize,
  initials,
  kindLabel,
  modeLabel,
  statusLabel,
  typeLabel,
  zoneCity,
} from './labels';

describe('labels', () => {
  it('pins the type labels', () => {
    expect(EVENT_TYPES.map(typeLabel)).toEqual([
      'Transit',
      'Lodging',
      'Dining',
      'Activity',
      'Attraction',
      'Receipt',
      'Other',
    ]);
  });
  it('pins the transit mode labels', () => {
    expect(TRANSIT_MODES.map(modeLabel)).toEqual([
      'Flight',
      'Train',
      'Bus',
      'Ferry',
      'Car',
      'Other',
    ]);
  });
  it('pins the status labels', () => {
    expect(statusLabel('confirmed')).toBe('Confirmed');
    expect(statusLabel('cancelled')).toBe('Cancelled');
  });
  it('turns underscores and hyphens into spaces', () => {
    expect(capitalize('premium_economy')).toBe('Premium economy');
    expect(capitalize('night-train')).toBe('Night train');
    expect(capitalize('')).toBe('');
  });
  it('kindLabel prefers the transit mode', () => {
    expect(kindLabel({ type: 'transit', mode: 'train' })).toBe('Train');
    expect(kindLabel({ type: 'transit', mode: 'other' })).toBe('Transit');
    expect(kindLabel({ type: 'dining' })).toBe('Dining');
  });
  it('initials and zoneCity', () => {
    expect(initials('Sam Lee')).toBe('SL');
    expect(initials('')).toBe('?');
    expect(zoneCity('America/New_York')).toBe('New York');
  });
});
