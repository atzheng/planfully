import { z } from 'zod';
import { EventSchema } from './schema';

export const RecordBodySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('put'), event: EventSchema }),
  z.strictObject({
    kind: z.literal('patch'),
    target: z.string().min(1),
    // any subset of the event's fields except id
    fields: EventSchema.omit({ id: true }).partial(),
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
