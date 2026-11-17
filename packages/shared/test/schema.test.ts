import { describe, expect, test } from 'vitest';
import {
  EventSchema,
  LocalTimeSchema,
  OpenedRecordSchema,
  ParsedEventSchema,
  RecordBodySchema,
  StoredRecordSchema,
  TripMetaSchema,
  eventsJsonSchema,
} from '../src';
import {
  flightEvent,
  lodgingEvent,
  sampleEvents,
  sampleParsedEvents,
  sampleTripMeta,
} from './fixtures';

describe('schemas', () => {
  test('accept fixtures', () => {
    for (const e of sampleEvents) expect(EventSchema.parse(e)).toEqual(e);
    expect(TripMetaSchema.parse(sampleTripMeta)).toEqual(sampleTripMeta);
    for (const e of sampleParsedEvents) expect(ParsedEventSchema.parse(e)).toEqual(e);
  });

  test('reject unknown type', () => {
    expect(EventSchema.safeParse({ ...flightEvent, type: 'spaceship' }).success).toBe(false);
  });
  test('reject bad tz', () => {
    expect(
      LocalTimeSchema.safeParse({ local: '2026-06-01T10:00', tz: 'Mars/Olympus' }).success,
    ).toBe(false);
    expect(
      EventSchema.safeParse({ ...flightEvent, start: { local: '2026-06-01T10:00', tz: 'nope' } })
        .success,
    ).toBe(false);
  });
  test('reject malformed local time', () => {
    for (const local of [
      '2026-06-01',
      '2026-06-01T10:00:00',
      '2026-06-01T10:00Z',
      '2026-06-01T10:00+02:00',
      '2026-13-01T10:00',
      '2026-02-30T10:00',
      '2026-06-01T24:00',
      'garbage',
    ]) {
      expect(LocalTimeSchema.safeParse({ local, tz: 'Europe/Paris' }).success, local).toBe(false);
    }
  });
  test('reject missing id / name', () => {
    const { id: _id, ...noId } = flightEvent;
    const { name: _name, ...noName } = flightEvent;
    expect(EventSchema.safeParse(noId).success).toBe(false);
    expect(EventSchema.safeParse(noName).success).toBe(false);
    expect(EventSchema.safeParse({ ...flightEvent, name: '' }).success).toBe(false);
  });
});

describe('records', () => {
  test('RecordBody variants', () => {
    expect(RecordBodySchema.safeParse({ kind: 'put', event: lodgingEvent }).success).toBe(true);
    expect(
      RecordBodySchema.safeParse({
        kind: 'patch',
        target: 'x',
        fields: { notes: 'hi', deleted: true },
      }).success,
    ).toBe(true);
    expect(RecordBodySchema.safeParse({ kind: 'delete', target: 'x' }).success).toBe(true);
    expect(
      RecordBodySchema.safeParse({ kind: 'patch', target: 'x', fields: { id: 'y' } }).success,
    ).toBe(false);
    expect(RecordBodySchema.safeParse({ kind: 'nope' }).success).toBe(false);
  });
  test('StoredRecord and OpenedRecord', () => {
    const base = { seq: 1, dedupe: null, createdAt: '2026-05-01T10:00:00.000Z' };
    expect(StoredRecordSchema.safeParse({ ...base, ciphertext: 'AAAA' }).success).toBe(true);
    expect(
      OpenedRecordSchema.safeParse({ ...base, body: { kind: 'delete', target: 'x' } }).success,
    ).toBe(true);
    expect(
      OpenedRecordSchema.safeParse({ ...base, seq: 'a', body: { kind: 'delete', target: 'x' } })
        .success,
    ).toBe(false);
  });
});

// Minimal validator for the JSON Schema subset eventsJsonSchema uses.
type JS = {
  type?: string;
  properties?: Record<string, JS>;
  required?: readonly string[];
  items?: JS;
  enum?: readonly unknown[];
  additionalProperties?: boolean;
};
function validate(s: JS, v: unknown): boolean {
  if (s.enum && !s.enum.includes(v)) return false;
  switch (s.type) {
    case 'array':
      return (
        Array.isArray(v) && s.items !== undefined && v.every((x) => validate(s.items as JS, x))
      );
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
      const o = v as Record<string, unknown>;
      if (!(s.required ?? []).every((k) => k in o)) return false;
      return Object.entries(o).every(([k, x]) => {
        const p = s.properties?.[k];
        return p ? validate(p, x) : s.additionalProperties !== false;
      });
    }
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number';
    case 'integer':
      return Number.isInteger(v);
    case 'boolean':
      return typeof v === 'boolean';
    default:
      return true;
  }
}

describe('eventsJsonSchema', () => {
  test('validates sample ParsedEvent[]', () => {
    expect(validate(eventsJsonSchema as JS, sampleParsedEvents)).toBe(true);
  });
  test('rejects bad data', () => {
    const first = sampleParsedEvents[0];
    expect(validate(eventsJsonSchema as JS, [{ ...first, type: 'x' }])).toBe(false);
    expect(validate(eventsJsonSchema as JS, [{ ...first, extra: 1 }])).toBe(false);
    expect(validate(eventsJsonSchema as JS, [{ name: 'n' }])).toBe(false);
  });
  test('all objects closed and no unsupported keywords', () => {
    const walk = (s: unknown): void => {
      if (typeof s !== 'object' || s === null) return;
      const o = s as Record<string, unknown>;
      if (o.type === 'object') expect(o.additionalProperties).toBe(false);
      for (const k of [
        'minLength',
        'maxLength',
        'minimum',
        'maximum',
        'pattern',
        'format',
        'oneOf',
        'allOf',
        '$ref',
        'default',
      ])
        expect(k in o).toBe(false);
      Object.values(o).forEach(walk);
    };
    walk(eventsJsonSchema);
  });
  test('property set matches ParsedEventSchema', () => {
    expect(Object.keys(eventsJsonSchema.items.properties).sort()).toEqual(
      Object.keys(ParsedEventSchema.shape).sort(),
    );
  });
});
