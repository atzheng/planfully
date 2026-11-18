import { describe, expect, it } from 'vitest';
import { errorMessage, locateReducer, sanitizeAccuracy, showAccuracyCircle } from './locate';

describe('locateReducer', () => {
  it('goes off -> requesting -> on -> off', () => {
    let s = locateReducer({ status: 'off' }, { type: 'start' });
    expect(s.status).toBe('requesting');
    s = locateReducer(s, { type: 'position', lat: 1, lng: 2, accuracy: 30 });
    expect(s).toEqual({ status: 'on', lat: 1, lng: 2, accuracy: 30 });
    s = locateReducer(s, { type: 'stop' });
    expect(s.status).toBe('off');
  });
  it('ignores a late fix once off', () => {
    const s = locateReducer({ status: 'off' }, { type: 'position', lat: 1, lng: 2, accuracy: 3 });
    expect(s.status).toBe('off');
  });
  it('error gives a message; start retries', () => {
    let s = locateReducer({ status: 'requesting' }, { type: 'error', code: 1 });
    expect(s).toEqual({ status: 'denied', message: 'Location permission denied' });
    s = locateReducer(s, { type: 'start' });
    expect(s.status).toBe('requesting');
  });
  it('ignores an error after stop', () => {
    expect(locateReducer({ status: 'off' }, { type: 'error', code: 2 }).status).toBe('off');
  });
});

describe('helpers', () => {
  it('messages', () => {
    expect(errorMessage(2)).toMatch(/unavailable/);
    expect(errorMessage('unsupported')).toMatch(/not available/);
  });
  it('accuracy', () => {
    expect(sanitizeAccuracy(0)).toBe(1);
    expect(sanitizeAccuracy(NaN)).toBe(1);
    expect(sanitizeAccuracy(42)).toBe(42);
    expect(showAccuracyCircle(3)).toBe(false);
    expect(showAccuracyCircle(50)).toBe(true);
  });
});
