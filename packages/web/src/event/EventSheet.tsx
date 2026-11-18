import { Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Attachment, Event, Location, RosterMember } from '@planfully/shared';
import { Check, Copy, ExternalLink, FileText, Mail, MapPin, Pencil, Trash2 } from 'lucide-react';
import { stringCodec, useQueryState } from '../lib/queryState';
import { useBlobCached } from '../offline/useBlobCached';
import { fetchAttachment } from '../trip/attachments';
import { useTripActions } from '../trip/actions';
import { useTrip, useTripStore } from '../trip/store';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { EventIcon } from '../ui/EventIcon';
import { IconButton } from '../ui/IconButton';
import { Sheet } from '../ui/Sheet';
import {
  formatDuration,
  formatLocalTime,
  formatSize,
  isEmailAttachment,
  mapsUrl,
  canOpenInline,
  opensInline,
} from './format';
import { initials, kindLabel } from './labels';
import { SheetHeader } from './SheetHeader';
import { diffFields } from './formModel';
import { EventForm } from './EventForm';
import { AttachButton } from './UploadButtons';
import styles from './EventSheet.module.css';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function hasPlace(l: Location): boolean {
  return Boolean(l.name || l.address || (l.lat !== undefined && l.lng !== undefined));
}

function LocationRow({ label, loc }: { label: string; loc: Location }) {
  const url = mapsUrl(loc);
  return (
    <Row label={label}>
      {loc.name && <div className={styles.strong}>{loc.name}</div>}
      {loc.address && <div className={styles.muted}>{loc.address}</div>}
      {url && (
        <a className={styles.link} href={url} target="_blank" rel="noopener noreferrer">
          <MapPin size={13} aria-hidden="true" />
          Open in Google Maps
          <ExternalLink size={11} aria-hidden="true" />
        </a>
      )}
    </Row>
  );
}

function People({ ids, roster }: { ids: string[]; roster: readonly RosterMember[] }) {
  if (ids.length === 0) return <span>Everyone</span>;
  const people: string[] = [];
  let former = 0;
  for (const id of new Set(ids)) {
    const name = roster.find((r) => r.id === id)?.name;
    if (name) people.push(name);
    else former++;
  }
  return (
    <ul className={styles.people}>
      {people.map((n) => (
        <li key={n} className={styles.person}>
          <span className={styles.avatar} aria-hidden="true">
            {initials(n)}
          </span>
          {n}
        </li>
      ))}
      {former > 0 && (
        <li className={styles.person}>
          <span className={styles.avatar} aria-hidden="true">
            ?
          </span>
          {former === 1 ? 'Former participant' : `${former} former participants`}
        </li>
      )}
    </ul>
  );
}

// Lazy: the viewer and postal-mime stay out of the main bundle until an email is opened.
const EmailViewer = lazy(() => import('./EmailViewer').then((m) => ({ default: m.EmailViewer })));

function useOpenAttachment(a: Attachment) {
  const tripId = useTrip((s) => s.tripId);
  const keys = useTrip((s) => s.keys);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');

  const run = async (forceDownload = false) => {
    if (!keys) return;
    // Open synchronously so popup blockers allow it; navigate once the blob is ready.
    // The new window keeps `opener` (no `noopener`, which would make window.open return null).
    // That is safe here: we only do this for allowlisted inert types (pdf and raster images),
    // never for anything that can run script.
    const win = !forceDownload && opensInline(a.mime) ? window.open('', '_blank') : null;
    setState('loading');
    try {
      const blob = await fetchAttachment(a, { tripId, ...keys });
      const url = URL.createObjectURL(blob);
      // Magic-byte check: only open inline if the content really is the allowlisted type.
      const inline = win && (await canOpenInline(blob, a.mime));
      if (win && !inline) win.close();
      if (win && inline) {
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
  return { state, run };
}

function AttachmentRow({
  a,
  onViewEmail,
}: {
  a: Attachment;
  onViewEmail: (a: Attachment) => void;
}) {
  const { state, run } = useOpenAttachment(a);
  const offline = useBlobCached(a.id, state);
  const isEmail = isEmailAttachment(a);

  return (
    <li className={styles.file}>
      <span className={styles.fileIcon} aria-hidden="true">
        {isEmail ? <Mail size={16} /> : <FileText size={16} />}
      </span>
      <div className={styles.fileBody}>
        {isEmail ? (
          <div className={styles.fileName}>{a.filename}</div>
        ) : (
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => void run()}
            disabled={state === 'loading'}
          >
            {a.filename}
          </button>
        )}
        <div className={styles.meta}>
          {formatSize(a.size)}
          {offline && ' · Available offline'}
          {state === 'loading' && ' · Opening...'}
        </div>
        {isEmail && (
          <div className={styles.fileActions}>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onViewEmail(a)}
              data-testid="view-email"
            >
              View email
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void run(true)}
              disabled={state === 'loading'}
            >
              Download .eml
            </Button>
          </div>
        )}
        {state === 'error' && (
          <div role="alert" className={styles.error}>
            Could not open this file.
          </div>
        )}
      </div>
    </li>
  );
}

function EmailView({ a, onBack }: { a: Attachment; onBack: () => void }) {
  const { run } = useOpenAttachment(a);
  return (
    <Suspense fallback={<p role="status">Opening email...</p>}>
      <EmailViewer attachment={a} onBack={onBack} onDownload={() => void run(true)} />
    </Suspense>
  );
}

function WriteStatus() {
  const store = useTripStore();
  const pending = useTrip((s) => s.pending);
  const lastError = useTrip((s) => s.lastError);
  if (lastError) {
    return (
      <div role="alert" className={styles.error}>
        Could not save: {lastError.message}{' '}
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => store.getState().setWriteState({ lastError: null })}
        >
          Dismiss
        </button>
      </div>
    );
  }
  return pending > 0 ? (
    <div role="status" className={styles.meta}>
      Saving...
    </div>
  ) : null;
}

function Actions({
  event,
  onEdit,
  onDelete,
}: {
  event: Event;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <>
        <span className={styles.confirmText}>Delete this event?</span>
        <Button variant="danger" size="sm" onClick={onDelete}>
          Delete
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
          Keep
        </Button>
      </>
    );
  }
  return (
    <>
      <Button variant="ghost" size="sm" onClick={onEdit}>
        <Pencil size={14} aria-hidden="true" />
        Edit
      </Button>
      <AttachButton event={event} />
      <Button
        variant="ghost"
        size="sm"
        className={styles.deleteButton}
        onClick={() => setConfirming(true)}
      >
        <Trash2 size={14} aria-hidden="true" />
        Delete
      </Button>
    </>
  );
}

function Details({
  event,
  onEdit,
  onDelete,
  onViewEmail,
}: {
  event: Event;
  onEdit: () => void;
  onDelete: () => void;
  onViewEmail: (a: Attachment) => void;
}) {
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
      <dl className={styles.fields}>
        {(event.start || event.end) && (
          <Row label="When">
            <div className={styles.times}>
              {event.start && <div>{formatLocalTime(event.start)}</div>}
              {event.end && (
                <div>
                  {event.start && <span aria-hidden="true">to </span>}
                  {formatLocalTime(event.end)}
                </div>
              )}
              {duration && <div className={styles.muted}>{duration}</div>}
            </div>
          </Row>
        )}
        {event.location && hasPlace(event.location) && (
          <LocationRow label="Where" loc={event.location} />
        )}
        {event.endLocation && hasPlace(event.endLocation) && (
          <LocationRow label="Arrives at" loc={event.endLocation} />
        )}
        {event.confirmation && (
          <Row label="Confirmation">
            <span className={styles.confirmation}>
              <code>{event.confirmation}</code>
              <IconButton
                label={
                  copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy confirmation'
                }
                size="sm"
                onClick={copy}
              >
                {copied === 'ok' ? (
                  <Check size={14} aria-hidden="true" />
                ) : (
                  <Copy size={14} aria-hidden="true" />
                )}
              </IconButton>
            </span>
          </Row>
        )}
        <Row label="Who">
          <People ids={event.participants} roster={roster} />
        </Row>
        {event.notes && <Row label="Notes">{event.notes}</Row>}
        {files.length > 0 && (
          <Row label="Attachments">
            <ul className={styles.attachments}>
              {files.map((a) => (
                <AttachmentRow key={a.id} a={a} onViewEmail={onViewEmail} />
              ))}
            </ul>
          </Row>
        )}
        {emails.length > 0 && (
          <Row label="Original email">
            <ul className={styles.attachments}>
              {emails.map((a) => (
                <AttachmentRow key={a.id} a={a} onViewEmail={onViewEmail} />
              ))}
            </ul>
          </Row>
        )}
      </dl>
      <div className={styles.actions} data-slot="event-actions">
        <Actions event={event} onEdit={onEdit} onDelete={onDelete} />
      </div>
    </>
  );
}

export function EventSheet() {
  const [id, setId] = useQueryState('e', stringCodec, '');
  const status = useTrip((s) => s.status);
  if (!id || status === 'loading') return null;
  return <OpenSheet key={id} id={id} setId={setId} />;
}

function OpenSheet({ id, setId }: { id: string; setId: (v: string) => void }) {
  const events = useTrip((s) => s.events);
  const close = useCallback(() => setId(''), [setId]);
  const [editing, setEditing] = useState<Event | null>(null);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const actions = useTripActions();
  const event = events.find((e) => e.id === id);

  return (
    <Sheet open onClose={close} label={event?.name ?? 'Event not found'} side>
      <SheetHeader
        icon={event ? <EventIcon event={event} size={18} /> : undefined}
        type={event?.type}
        title={event ? event.name : 'Event not found'}
        subtitle={event && !editing && !viewing ? kindLabel(event) : undefined}
        badges={
          event && !editing && !viewing ? (
            <>
              {event.status === 'cancelled' && <Badge tone="danger">Cancelled</Badge>}
              {event.needsReview && <Badge tone="warning">Needs review</Badge>}
            </>
          ) : undefined
        }
        onClose={close}
      />
      <WriteStatus />
      {!event ? (
        <p>This event may have been deleted.</p>
      ) : editing ? (
        <EventForm
          initial={editing}
          onCancel={() => setEditing(null)}
          onSubmit={async (fields) => {
            // Diff against the snapshot the form opened with, not the live event: a sync in
            // between must not put untouched stale values into the patch.
            const changes = diffFields(editing, fields);
            if (Object.keys(changes).length > 0) await actions.patchEvent(event.id, changes);
            setEditing(null);
          }}
        />
      ) : viewing ? (
        <EmailView a={viewing} onBack={() => setViewing(null)} />
      ) : (
        <Details
          event={event}
          onViewEmail={setViewing}
          onEdit={() => setEditing(event)}
          onDelete={() => {
            close();
            // The write path restores the event and sets lastError on failure: reopen to show it.
            actions.deleteEvent(event.id).catch(() => setId(event.id));
          }}
        />
      )}
    </Sheet>
  );
}
