import { describe, expect, it } from 'vitest';
import { formatDuration, formatLocalTime, mapsUrl, opensInline, participantNames } from './format';

describe('format', () => {
  it('formats in the event zone with abbreviation', () => {
    expect(formatLocalTime({ local: '2026-07-14T09:30', tz: 'Europe/Paris' })).toMatch(
      /^Tue 14 Jul 2026, 09:30 \S+$/,
    );
  });
  it('duration', () => {
    const tz = 'Europe/Paris';
    expect(
      formatDuration({ local: '2026-07-14T09:00', tz }, { local: '2026-07-14T12:30', tz }),
    ).toBe('3h 30m');
    expect(
      formatDuration({ local: '2026-07-14T09:00', tz }, { local: '2026-07-14T08:00', tz }),
    ).toBeNull();
  });
  it('participants', () => {
    const r = [{ id: 'a', name: 'Ann', aliases: [] }];
    expect(participantNames({ participants: [] }, r)).toBe('Everyone');
    expect(participantNames({ participants: ['a', 'zz'] }, r)).toBe('Ann, Former participant');
    expect(participantNames({ participants: ['y', 'zz'] }, r)).toBe('2 former participants');
  });
  it('maps url prefers lat/lng', () => {
    expect(mapsUrl({ name: 'X', lat: 1, lng: 2 })).toContain('query=1%2C2');
    expect(mapsUrl({ name: 'X', address: 'Y' })).toContain('query=X%2C%20Y');
    expect(mapsUrl({})).toBeNull();
  });
  it('never opens scriptable types inline', () => {
    expect(opensInline('application/pdf')).toBe(true);
    expect(opensInline('text/html')).toBe(false);
    expect(opensInline('image/svg+xml')).toBe(false);
  });
});
