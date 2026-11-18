import { describe, expect, it } from 'vitest';
import { localTimeAbbreviation, utcOffsetLabel, zoneAbbreviation } from './time';

const at = (iso: string) => Date.parse(iso);

describe('zoneAbbreviation', () => {
  it('names Lisbon WET/WEST, not GMT+0', () => {
    expect(zoneAbbreviation('Europe/Lisbon', at('2026-01-15T12:00:00Z'))).toBe('WET');
    expect(zoneAbbreviation('Europe/Lisbon', at('2026-07-15T12:00:00Z'))).toBe('WEST');
  });
  it('handles London, Paris, New York, Sydney', () => {
    expect(zoneAbbreviation('Europe/London', at('2026-07-01T00:00:00Z'))).toBe('BST');
    expect(zoneAbbreviation('Europe/London', at('2026-12-01T00:00:00Z'))).toBe('GMT');
    expect(zoneAbbreviation('Europe/Paris', at('2026-07-01T00:00:00Z'))).toBe('CEST');
    expect(zoneAbbreviation('America/New_York', at('2026-12-01T00:00:00Z'))).toBe('EST');
    expect(zoneAbbreviation('America/Los_Angeles', at('2026-07-01T00:00:00Z'))).toBe('PDT');
    expect(zoneAbbreviation('Australia/Sydney', at('2026-01-15T00:00:00Z'))).toBe('AEDT');
    expect(zoneAbbreviation('Australia/Sydney', at('2026-07-15T00:00:00Z'))).toBe('AEST');
    expect(zoneAbbreviation('Pacific/Auckland', at('2026-01-15T00:00:00Z'))).toBe('NZDT');
  });
  it('switches exactly at the DST boundary', () => {
    expect(zoneAbbreviation('Europe/Paris', at('2026-03-29T00:59:59Z'))).toBe('CET');
    expect(zoneAbbreviation('Europe/Paris', at('2026-03-29T01:00:00Z'))).toBe('CEST');
    expect(zoneAbbreviation('America/New_York', at('2026-11-01T05:59:59Z'))).toBe('EDT');
    expect(zoneAbbreviation('America/New_York', at('2026-11-01T06:00:00Z'))).toBe('EST');
  });
  it('covers zones without DST and half-hour zones', () => {
    expect(zoneAbbreviation('Asia/Tokyo', at('2026-07-01T00:00:00Z'))).toBe('JST');
    expect(zoneAbbreviation('Asia/Seoul', at('2026-07-01T00:00:00Z'))).toBe('KST');
    expect(zoneAbbreviation('Asia/Kolkata', at('2026-07-01T00:00:00Z'))).toBe('IST');
    expect(zoneAbbreviation('Asia/Singapore', at('2026-07-01T00:00:00Z'))).toBe('SGT');
    expect(zoneAbbreviation('Australia/Adelaide', at('2026-07-01T00:00:00Z'))).toBe('ACST');
    expect(zoneAbbreviation('Australia/Adelaide', at('2026-01-01T00:00:00Z'))).toBe('ACDT');
  });
  it('falls back to a UTC offset for unknown zones', () => {
    expect(zoneAbbreviation('Asia/Kathmandu', at('2026-07-01T00:00:00Z'))).toBe('UTC+5:45');
    expect(zoneAbbreviation('Asia/Tehran', at('2026-01-01T00:00:00Z'))).toBe('UTC+3:30');
    expect(zoneAbbreviation('America/Caracas', at('2026-07-01T00:00:00Z'))).toBe('UTC-4');
    expect(zoneAbbreviation('UTC', at('2026-07-01T00:00:00Z'))).toBe('UTC');
  });
  it('returns the input for an invalid zone', () => {
    expect(zoneAbbreviation('Not/AZone', 0)).toBe('Not/AZone');
  });
  it('works from a local time', () => {
    expect(localTimeAbbreviation({ local: '2026-07-15T09:00', tz: 'Europe/Lisbon' })).toBe('WEST');
  });
  it('does not throw for invalid input and skips ambiguous abbreviations', () => {
    expect(localTimeAbbreviation({ local: '2026-07-15T09:00', tz: 'Not/AZone' })).toBe('Not/AZone');
    expect(localTimeAbbreviation({ local: 'garbage', tz: 'Europe/Paris' })).toBe('Europe/Paris');
    const ms = at('2026-07-01T00:00:00Z');
    expect(zoneAbbreviation('Asia/Shanghai', ms)).toBe('UTC+8');
    expect(zoneAbbreviation('Asia/Hong_Kong', ms)).toBe('UTC+8');
    expect(zoneAbbreviation('Asia/Taipei', ms)).toBe('UTC+8');
    expect(zoneAbbreviation('Asia/Dhaka', ms)).toBe('UTC+6');
    expect(zoneAbbreviation('Asia/Jerusalem', ms)).toBe('UTC+3');
  });
  it('formats offsets', () => {
    expect(utcOffsetLabel(-570)).toBe('UTC-9:30');
    expect(utcOffsetLabel(120)).toBe('UTC+2');
  });
});
