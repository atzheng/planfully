import type { Attachment } from '@planfully/shared';
import type { TripRow } from '../db/trips';
import type { Env } from '../env';

/** An inbound email after MIME parsing (CONTRACTS.md section 6). */
export type ParsedEmail = {
  from: string;
  to: string;
  suffix: string;
  subject: string;
  date: string;
  text?: string;
  html?: string;
  attachments: { filename: string; mime: string; bytes: Uint8Array }[];
  /** the sealed raw .eml, already stored */
  sourceAttachment: Attachment;
};

/** What to do with a parsed email for one address suffix (CONTRACTS.md section 6). */
export type EmailRoute = (ctx: { env: Env; trip: TripRow; email: ParsedEmail }) => Promise<void>;
