import { IANAZone } from 'luxon';
import { z } from 'zod';

export const EVENT_TYPES = [
  'flight',
  'train',
  'bus',
  'ferry',
  'car',
  'lodging',
  'dining',
  'activity',
  'attraction',
  'receipt',
  'other',
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function isValidLocal(s: string): boolean {
  const m = LOCAL_RE.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || d < 1) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim;
}

/** Local wall-clock time 'YYYY-MM-DDTHH:mm' (no offset, no seconds) plus IANA zone. */
export const LocalTimeSchema = z.strictObject({
  local: z.string().refine(isValidLocal, 'expected local time YYYY-MM-DDTHH:mm'),
  tz: z.string().refine((s) => IANAZone.isValidZone(s), 'invalid IANA time zone'),
});
export type LocalTime = z.infer<typeof LocalTimeSchema>;

export const LocationSchema = z.strictObject({
  name: z.string().optional(),
  address: z.string().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  placeId: z.string().optional(),
});
export type Location = z.infer<typeof LocationSchema>;

export const AttachmentSchema = z.strictObject({
  /** blob id */
  id: z.string().min(1),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  kind: z.enum(['file', 'source-email']),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

export const EventStatusSchema = z.enum(['confirmed', 'cancelled']);
export const EventSourceSchema = z.enum(['email', 'manual']);

export const EventSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  type: EventTypeSchema,
  start: LocalTimeSchema.optional(),
  end: LocalTimeSchema.optional(),
  confirmation: z.string().optional(),
  location: LocationSchema.optional(),
  /** arrival point for transport */
  endLocation: LocationSchema.optional(),
  attachments: z.array(AttachmentSchema),
  /** roster ids; [] means everyone */
  participants: z.array(z.string()),
  status: EventStatusSchema,
  notes: z.string().optional(),
  source: EventSourceSchema,
  needsReview: z.boolean().optional(),
  /** ISO instant */
  createdAt: z.string().min(1),
  /** field names set by hand */
  pinned: z.array(z.string()).optional(),
  /** tombstone */
  deleted: z.boolean().optional(),
});
export type Event = z.infer<typeof EventSchema>;

export const RosterMemberSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()),
});
export type RosterMember = z.infer<typeof RosterMemberSchema>;

export const TripMetaSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  address: z.string().min(1),
  domain: z.string().min(1),
  /** base64url */
  publicKey: z.string().min(1),
  roster: z.array(RosterMemberSchema),
  allowedSenders: z.array(z.string()),
  createdAt: z.string().min(1),
});
export type TripMeta = z.infer<typeof TripMetaSchema>;

/** What the LLM parser returns per event (CONTRACTS.md section 6). */
export const ParsedEventSchema = z.strictObject({
  ...EventSchema.omit({
    id: true,
    attachments: true,
    source: true,
    createdAt: true,
    pinned: true,
    deleted: true,
  }).shape,
  /** indexes into email.attachments */
  attachmentIndexes: z.array(z.number().int().nonnegative()),
});
export type ParsedEvent = z.infer<typeof ParsedEventSchema>;

// JSON Schema for ParsedEvent[], for LLM structured output. Hand-written to use only
// widely supported keywords (type, properties, required, items, enum, additionalProperties:false).
const str = { type: 'string' } as const;
const localTimeJson = {
  type: 'object',
  properties: {
    local: { ...str, description: 'Local wall-clock time, format YYYY-MM-DDTHH:mm, no offset' },
    tz: { ...str, description: 'IANA time zone of that place, e.g. Europe/Paris' },
  },
  required: ['local', 'tz'],
  additionalProperties: false,
} as const;
const locationJson = {
  type: 'object',
  properties: {
    name: str,
    address: str,
    lat: { type: 'number' },
    lng: { type: 'number' },
    placeId: str,
  },
  required: [],
  additionalProperties: false,
} as const;

export const eventsJsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      name: str,
      type: { type: 'string', enum: [...EVENT_TYPES] },
      start: localTimeJson,
      end: localTimeJson,
      confirmation: str,
      location: locationJson,
      endLocation: locationJson,
      participants: { type: 'array', items: str },
      status: { type: 'string', enum: ['confirmed', 'cancelled'] },
      notes: str,
      needsReview: { type: 'boolean' },
      attachmentIndexes: { type: 'array', items: { type: 'integer' } },
    },
    required: ['name', 'type', 'participants', 'status', 'attachmentIndexes'],
    additionalProperties: false,
  },
} as const;
