import { fromInstant } from '@planfully/shared';
import type { Attachment } from '@planfully/shared';
import { BlobTooLargeError } from '../../storage/blobs';
import { appendEvent, storeAttachment } from '../store';
import type { EmailRoute } from '../types';

/** The email's Date header as a UTC LocalTime; now when it is missing or unparseable. */
function startFor(dateHeader: string) {
  const t = Date.parse(dateHeader);
  return fromInstant(Number.isNaN(t) ? Date.now() : t, 'UTC');
}

/**
 * The +receipts route (SPEC.md section 5): no LLM. One receipt event named after the subject,
 * dated by the email, holding the email's files and the source email. Errors propagate to the
 * handler, which logs only the error name.
 */
export const receiptsRoute: EmailRoute = async ({ env, trip, email }) => {
  const files: Attachment[] = [];
  for (const f of email.attachments) {
    try {
      files.push(await storeAttachment(env, trip, f));
    } catch (err) {
      if (err instanceof BlobTooLargeError) continue;
      throw err;
    }
  }
  await appendEvent(
    env,
    trip,
    {
      id: crypto.randomUUID(),
      type: 'receipt',
      name: email.subject || 'Receipt',
      start: startFor(email.date),
      attachments: [...files, email.sourceAttachment],
      participants: [],
      status: 'confirmed',
      source: 'email',
      createdAt: new Date().toISOString(),
    },
    null,
  );
};
