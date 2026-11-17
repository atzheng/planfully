import type { Attachment } from '@planfully/shared';

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
