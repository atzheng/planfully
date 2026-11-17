import { z } from 'zod';
import { EventSchema } from './schema';

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
    // any subset of the event's fields except id; optional fields may be null to clear them
    fields: EventSchema.omit({ id: true }).partial().extend({
      start: EventSchema.shape.start.nullable(),
      end: EventSchema.shape.end.nullable(),
      confirmation: EventSchema.shape.confirmation.nullable(),
      location: EventSchema.shape.location.nullable(),
      endLocation: EventSchema.shape.endLocation.nullable(),
      notes: EventSchema.shape.notes.nullable(),
      needsReview: EventSchema.shape.needsReview.nullable(),
    }),
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
