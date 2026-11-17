import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Attachment, Event, Location } from '@planfully/shared';
import { stringCodec, useQueryState } from '../lib/queryState';
import { fetchAttachment } from '../trip/attachments';
import { useTrip } from '../trip/store';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Sheet } from '../ui/Sheet';
import {
  formatDuration,
  formatLocalTime,
  formatSize,
  mapsUrl,
  opensInline,
  participantNames,
} from './format';
import styles from './EventSheet.module.css';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function LocationField({ label, loc }: { label: string; loc: Location }) {
  const url = mapsUrl(loc);
  return (
    <Field label={label}>
      {loc.name && <div>{loc.name}</div>}
      {loc.address && <div>{loc.address}</div>}
      {url && (
        <a className={styles.link} href={url} target="_blank" rel="noopener noreferrer">
          Open in Google Maps
        </a>
      )}
    </Field>
  );
}

function AttachmentRow({ a }: { a: Attachment }) {
  const tripId = useTrip((s) => s.tripId);
  const keys = useTrip((s) => s.keys);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');

  const onClick = async () => {
    if (!keys) return;
    // Open synchronously so popup blockers allow it; navigate once the blob is ready.
    // The new window keeps `opener` (no `noopener`, which would make window.open return null).
    // That is safe here: we only do this for allowlisted inert types (pdf and raster images),
    // never for anything that can run script.
    const win = opensInline(a.mime) ? window.open('', '_blank') : null;
    setState('loading');
    try {
      const blob = await fetchAttachment(a, { tripId, ...keys });
      const url = URL.createObjectURL(blob);
      if (win) {
        win.location.href = url;
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = a.filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }
      // Revoke once the tab or download has had time to start. Deliberately not tied to the
      // sheet's lifetime: closing the sheet must not break a tab that is still loading.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setState('idle');
    } catch {
      win?.close();
      setState('error');
    }
  };

  return (
    <li>
      <button
        type="button"
        className={styles.linkButton}
        onClick={() => void onClick()}
        disabled={state === 'loading'}
      >
        {a.filename}
      </button>{' '}
      <span className={styles.meta}>
        {formatSize(a.size)}
        {state === 'loading' && ' · Opening...'}
      </span>
      {state === 'error' && (
        <div role="alert" className={styles.error}>
          Could not open this file.
        </div>
      )}
    </li>
  );
}

function Details({ event }: { event: Event }) {
  const roster = useTrip((s) => s.meta?.roster ?? []);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  useEffect(() => {
    if (copied === 'idle') return;
    const t = setTimeout(() => setCopied('idle'), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const files = event.attachments.filter((a) => a.kind === 'file');
  const emails = event.attachments.filter((a) => a.kind === 'source-email');
  const duration = event.start && event.end ? formatDuration(event.start, event.end) : null;

  const copy = () => {
    const write = navigator.clipboard?.writeText(event.confirmation ?? '');
    if (!write) {
      setCopied('failed');
      return;
    }
    write.then(
      () => setCopied('ok'),
      () => setCopied('failed'),
    );
  };

  return (
    <>
      <div className={styles.badges}>
        <span className={styles.badge}>{event.type}</span>
        {event.status === 'cancelled' && (
          <span className={`${styles.badge} ${styles.warn}`}>Cancelled</span>
        )}
        {event.needsReview && (
          <span className={`${styles.badge} ${styles.warn}`}>Needs review</span>
        )}
      </div>
      <dl className={styles.fields}>
        {event.start && <Field label="Start">{formatLocalTime(event.start)}</Field>}
        {event.end && <Field label="End">{formatLocalTime(event.end)}</Field>}
        {duration && <Field label="Duration">{duration}</Field>}
        {event.confirmation && (
          <Field label="Confirmation">
            <span className={styles.row}>
              <code>{event.confirmation}</code>
              <Button onClick={copy}>
                {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}
              </Button>
            </span>
          </Field>
        )}
        {event.location && <LocationField label="Location" loc={event.location} />}
        {event.endLocation && <LocationField label="Arrives at" loc={event.endLocation} />}
        <Field label="Participants">{participantNames(event, roster)}</Field>
        {event.notes && <Field label="Notes">{event.notes}</Field>}
        {files.length > 0 && (
          <Field label="Attachments">
            <ul className={styles.attachments}>
              {files.map((a) => (
                <AttachmentRow key={a.id} a={a} />
              ))}
            </ul>
          </Field>
        )}
        {emails.length > 0 && (
          <Field label="Original email">
            <ul className={styles.attachments}>
              {emails.map((a) => (
                <AttachmentRow key={a.id} a={a} />
              ))}
            </ul>
          </Field>
        )}
      </dl>
      {/* Actions row: planfully-ecw.2 adds Edit and Delete, planfully-ecw.4 adds Attach. */}
      <div className={styles.actions} data-slot="event-actions" />
    </>
  );
}

export function EventSheet() {
  const [id, setId] = useQueryState('e', stringCodec, '');
  const events = useTrip((s) => s.events);
  const status = useTrip((s) => s.status);
  const close = useCallback(() => setId(''), [setId]);
  if (!id || status === 'loading') return null;
  const event = events.find((e) => e.id === id);

  return (
    <Sheet open onClose={close} label={event?.name ?? 'Event not found'} side>
      <div className={styles.header}>
        <h2 className={styles.title}>{event ? event.name : 'Event not found'}</h2>
        <IconButton label="Close" onClick={close}>
          ×
        </IconButton>
      </div>
      {event ? <Details event={event} /> : <p>This event may have been deleted.</p>}
    </Sheet>
  );
}
