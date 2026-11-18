// Direct uploads (planfully-ecw.4): attach files to an event, or create receipt events from files.

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { Paperclip } from 'lucide-react';
import { fromInstant, type Attachment, type Event } from '@planfully/shared';
import { ApiError } from '../lib/api';
import { getTripQueue } from '../offline/queue';
import { useTripActions } from '../trip/actions';
import { FileTooLargeError, uploadAttachment, type UploadContext } from '../trip/attachments';
import { useTrip, useTripStore } from '../trip/store';
import { Button } from '../ui/Button';
import styles from './UploadButtons.module.css';

/** 'Boarding pass.pdf' -> 'Boarding pass'; falls back when nothing is left. */
export function receiptName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const base = (dot > 0 ? filename.slice(0, dot) : filename).trim();
  return base || 'Receipt';
}

/** Say what went wrong in terms a person can act on: too large, server refused, or offline. */
export function describeUploadError(
  e: unknown,
  filename: string,
  stage: 'upload' | 'save',
): string {
  if (e instanceof FileTooLargeError) return e.message;
  const what = stage === 'upload' ? 'could not be uploaded' : 'was uploaded but could not be saved';
  if (e instanceof ApiError) {
    if (e.status === 413) return `${filename} is too large for the server.`;
    if (e.status === 401 || e.status === 403)
      return `${filename} ${what}: this link no longer has access.`;
    return `${filename} ${what}: the server refused it (${e.status}).`;
  }
  return `${filename} ${what}: check your connection and try again.`;
}

/**
 * Attachments for a patch: the event as it is now (not as it was when the uploads started),
 * plus the new ones, skipping ids that are already there.
 */
export function mergeAttachments(current: Attachment[], added: Attachment[]): Attachment[] {
  const have = new Set(current.map((a) => a.id));
  return [...current, ...added.filter((a) => !have.has(a.id))];
}

/** A failure after a successful upload, already described for the person. */
class SaveError extends Error {}

type Progress = { done: number; total: number; current: string } | null;

function useUploader() {
  const tripId = useTrip((s) => s.tripId);
  const keys = useTrip((s) => s.keys);
  const store = useTripStore();
  const [progress, setProgress] = useState<Progress>(null);
  const [error, setError] = useState<string | null>(null);

  /** Runs `each` for every file in order; a failure is reported and the rest still run. */
  async function run(
    files: File[],
    each: (file: File, ctx: UploadContext) => Promise<void>,
  ): Promise<void> {
    if (!keys || files.length === 0) return;
    const ctx: UploadContext = { tripId, ...keys, queue: getTripQueue(store) };
    const failures: string[] = [];
    setError(null);
    for (let i = 0; i < files.length; i++) {
      const file = files[i] as File;
      setProgress({ done: i, total: files.length, current: file.name });
      try {
        await each(file, ctx);
      } catch (e) {
        // A save failure arrives already described; anything else came from the upload step.
        failures.push(
          e instanceof SaveError ? e.message : describeUploadError(e, file.name, 'upload'),
        );
      }
    }
    setProgress(null);
    if (failures.length > 0) setError(failures.join(' '));
  }
  return { run, progress, error, setError, busy: progress !== null };
}

function Status({ progress, error }: { progress: Progress; error: string | null }) {
  return (
    <>
      {progress && (
        <span role="status" className={styles.status}>
          Uploading {Math.min(progress.done + 1, progress.total)} of {progress.total}:{' '}
          {progress.current}
        </span>
      )}
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
    </>
  );
}

/** Attach one or more files to an existing event. */
export function AttachButton({ event }: { event: Event }) {
  const actions = useTripActions();
  const store = useTripStore();
  const input = useRef<HTMLInputElement>(null);
  const { run, progress, error, setError, busy } = useUploader();

  const onFiles = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (input.current) input.current.value = '';
    const added: Attachment[] = [];
    await run(files, async (file, ctx) => {
      added.push(await uploadAttachment(file, ctx));
    });
    if (added.length === 0) return;
    // Patch once with everything that uploaded; a failed save shows in the sheet's status line.
    const current = store.getState().events.find((e) => e.id === event.id) ?? event;
    await actions
      .patchEvent(event.id, { attachments: mergeAttachments(current.attachments, added) })
      .catch((e: unknown) =>
        setError(describeUploadError(e, added.map((a) => a.filename).join(', '), 'save')),
      );
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        data-testid="attach-input"
        onChange={(e) => void onFiles(e.target.files)}
      />
      <Button variant="ghost" size="sm" onClick={() => input.current?.click()} disabled={busy}>
        <Paperclip size={14} aria-hidden="true" />
        Attach
      </Button>
      <Status progress={progress} error={error} />
    </>
  );
}

/** Handle for opening the file picker from a menu item. */
export type ReceiptPicker = { pick(): void };

/**
 * Create one receipt event per picked or captured file. Renders the hidden file input and the
 * upload status; the trigger lives elsewhere (the app bar's overflow menu) and calls `pick()`.
 */
export const AddReceiptAction = forwardRef<ReceiptPicker>(function AddReceiptAction(_props, ref) {
  const actions = useTripActions();
  const input = useRef<HTMLInputElement>(null);
  const { run, progress, error, busy } = useUploader();
  useImperativeHandle(ref, () => ({ pick: () => !busy && input.current?.click() }), [busy]);

  const onFiles = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (input.current) input.current.value = '';
    await run(files, async (file, ctx) => {
      const attachment = await uploadAttachment(file, ctx);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await actions
        .putEvent({
          type: 'receipt',
          name: receiptName(file.name),
          start: fromInstant(Date.now(), tz),
          attachments: [attachment],
        })
        .catch((e: unknown) => {
          throw new SaveError(describeUploadError(e, file.name, 'save'));
        });
    });
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf"
        multiple
        hidden
        data-testid="receipt-input"
        onChange={(e) => void onFiles(e.target.files)}
      />
      <Status progress={progress} error={error} />
    </>
  );
});
