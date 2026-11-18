import { useEffect, useMemo, useState } from 'react';
import type { Attachment } from '@planfully/shared';
import { fetchAttachment } from '../trip/attachments';
import { useTrip } from '../trip/store';
import { Button } from '../ui/Button';
import {
  EMAIL_IFRAME_SANDBOX,
  HEADER_PEEK_BYTES,
  MAX_EMAIL_BYTES,
  buildSrcdoc,
  contentBytes,
  extractHeaders,
  hasRemoteImages,
  linkify,
  listedAttachments,
  type ParsedAttachment,
  type ParsedEmail,
} from './emailModel';
import { canOpenInline, formatSize } from './format';
import { parseEmail } from './parseEmail';
import styles from './EmailViewer.module.css';

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'toolarge'; size: number; email: ParsedEmail }
  | { state: 'ready'; email: ParsedEmail };

async function openOrDownload(a: ParsedAttachment) {
  const blob = new Blob([contentBytes(a.content) as BlobPart], { type: a.mimeType });
  const url = URL.createObjectURL(blob);
  if (await canOpenInline(blob, a.mimeType)) {
    window.open(url, '_blank');
  } else {
    const link = document.createElement('a');
    link.href = url;
    link.download = a.filename ?? 'attachment';
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function TextBody({ text }: { text: string }) {
  return (
    <pre className={styles.text}>
      {linkify(text).map((s, i) =>
        s.href ? (
          <a key={i} href={s.href} target="_blank" rel="noopener noreferrer">
            {s.text}
          </a>
        ) : (
          s.text
        ),
      )}
    </pre>
  );
}

/** Shows a stored .eml inside the app. Rendered in place of the event details; `onBack` returns. */
export function EmailViewer({
  attachment,
  onBack,
  onDownload,
}: {
  attachment: Attachment;
  onBack: () => void;
  onDownload: () => void;
}) {
  const tripId = useTrip((s) => s.tripId);
  const keys = useTrip((s) => s.keys);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [remote, setRemote] = useState(false);

  useEffect(() => {
    if (!keys) return;
    let live = true;
    let cancel = () => {};
    (async () => {
      try {
        const blob = await fetchAttachment(attachment, { tripId, ...keys });
        // Too big to parse safely in a tab: show what the first chunk says and offer the download.
        const tooLarge = blob.size > MAX_EMAIL_BYTES;
        const data = await blob.slice(0, tooLarge ? HEADER_PEEK_BYTES : blob.size).arrayBuffer();
        // Parsed off the main thread; postal-mime stays out of the main bundle.
        const parse = parseEmail(data);
        cancel = parse.cancel;
        const email = await parse.promise;
        if (live) {
          setLoad(
            tooLarge
              ? {
                  state: 'toolarge',
                  size: blob.size,
                  email: { ...email, html: undefined, text: undefined, attachments: [] },
                }
              : { state: 'ready', email },
          );
        }
      } catch {
        if (live) setLoad({ state: 'error' });
      }
    })();
    return () => {
      live = false;
      cancel();
    };
  }, [attachment, tripId, keys]);

  const email = load.state === 'ready' || load.state === 'toolarge' ? load.email : null;
  const srcdoc = useMemo(
    () => (email?.html ? buildSrcdoc(email.html, email.attachments, { remoteImages: remote }) : ''),
    [email, remote],
  );
  const headers = email ? extractHeaders(email) : null;
  const inner = email ? listedAttachments(email) : [];

  return (
    <div>
      <div className={styles.bar}>
        <Button onClick={onBack}>Back</Button>
        <Button onClick={onDownload}>Download .eml</Button>
      </div>
      {load.state === 'loading' && <p role="status">Opening email...</p>}
      {load.state === 'error' && (
        <p role="alert" className={styles.error}>
          Could not open this email.
        </p>
      )}
      {load.state === 'toolarge' && (
        <p role="status" className={styles.notice}>
          This email is too large to view here ({formatSize(load.size)}). Use Download .eml.
        </p>
      )}
      {email && headers && (
        <>
          {headers.subject && <h3 className={styles.subject}>{headers.subject}</h3>}
          <dl className={styles.headers}>
            {(
              [
                ['From', headers.from],
                ['To', headers.to],
                ['Cc', headers.cc],
                ['Date', headers.date],
              ] as const
            ).map(
              ([label, value]) =>
                value && (
                  <div key={label} style={{ display: 'contents' }}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ),
            )}
          </dl>
          {load.state !== 'ready' ? null : email.html ? (
            <>
              {!remote && hasRemoteImages(email.html) && (
                <div className={styles.notice}>
                  Remote images are blocked.
                  <Button onClick={() => setRemote(true)}>Load remote images</Button>
                </div>
              )}
              <iframe
                title="Email body"
                className={styles.frame}
                sandbox={EMAIL_IFRAME_SANDBOX}
                referrerPolicy="no-referrer"
                srcDoc={srcdoc}
              />
            </>
          ) : email.text ? (
            <TextBody text={email.text} />
          ) : (
            <p className={styles.notice}>This email has no body.</p>
          )}
          {inner.length > 0 && (
            <>
              <h4 className={styles.h3}>Attachments</h4>
              <ul className={styles.inner}>
                {inner.map((a, i) => (
                  <li key={i}>
                    <button type="button" onClick={() => openOrDownload(a)}>
                      {a.filename ?? 'attachment'}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
