import { z } from 'zod';
import { EventObjectSchema, EventSchema, normalizeLegacyType } from './schema';

// Any subset of the event's fields except id; optional fields may be null to clear them.
// Legacy transport types in a patch read as transit + mode, like in a put.
const PatchFieldsSchema = z.preprocess(
  normalizeLegacyType,
  EventObjectSchema.omit({ id: true }).partial().extend({
    mode: EventObjectSchema.shape.mode.nullable(),
    start: EventObjectSchema.shape.start.nullable(),
    end: EventObjectSchema.shape.end.nullable(),
    confirmation: EventObjectSchema.shape.confirmation.nullable(),
    location: EventObjectSchema.shape.location.nullable(),
    endLocation: EventObjectSchema.shape.endLocation.nullable(),
    notes: EventObjectSchema.shape.notes.nullable(),
    needsReview: EventObjectSchema.shape.needsReview.nullable(),
  }),
);

export const RecordBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('put'),
    event: EventSchema,
    /**
     * Present on puts written by compaction: the event is a snapshot of a whole group.
     * `firstSeq` is the seq of the group's earliest put, `throughSeq` the last seq it replaces,
     * `aliases` the group's non-canonical put ids.
     */
    compaction: z
      .strictObject({
        firstSeq: z.number().int().nonnegative(),
        throughSeq: z.number().int().nonnegative(),
        aliases: z.array(z.string()),
      })
      .refine((c) => c.firstSeq <= c.throughSeq, 'firstSeq must be <= throughSeq')
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('patch'),
    target: z.string().min(1),
    fields: PatchFieldsSchema,
  }),
  z.strictObject({ kind: z.literal('delete'), target: z.string().min(1) }),
]);
export type RecordBody = z.infer<typeof RecordBodySchema>;

/** What the server stores and returns; it never sees the body. */
export const StoredRecordSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  dedupe: z.string().nullable(),
  /** base64 */
  ciphertext: z.string(),
  createdAt: z.string(),
});
export type StoredRecord = z.infer<typeof StoredRecordSchema>;

export const OpenedRecordSchema = z.strictObject({
  seq: z.number().int().nonnegative(),
  dedupe: z.string().nullable(),
  createdAt: z.string(),
  body: RecordBodySchema,
});
export type OpenedRecord = z.infer<typeof OpenedRecordSchema>;
