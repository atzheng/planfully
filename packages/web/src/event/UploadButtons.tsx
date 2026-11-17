// Direct uploads (planfully-ecw.4): attach files to an event, or create receipt events from files.

import { useRef, useState } from 'react';
import { fromInstant, type Attachment, type Event } from '@planfully/shared';
import { useTripActions } from '../trip/actions';
import { FileTooLargeError, uploadAttachment, type UploadContext } from '../trip/attachments';
import { useTrip } from '../trip/store';
import { Button } from '../ui/Button';
import styles from './UploadButtons.module.css';

/** 'Boarding pass.pdf' -> 'Boarding pass'; falls back when nothing is left. */
export function receiptName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const base = (dot > 0 ? filename.slice(0, dot) : filename).trim();
  return base || 'Receipt';
}

type Progress = { done: number; total: number; current: string } | null;

function useUploader() {
  const tripId = useTrip((s) => s.tripId);
  const keys = useTrip((s) => s.keys);
  const [progress, setProgress] = useState<Progress>(null);
  const [error, setError] = useState<string | null>(null);

  /** Runs `each` for every file in order; a failure is reported and the rest still run. */
  async function run(
    files: File[],
    each: (file: File, ctx: UploadContext) => Promise<void>,
  ): Promise<void> {
    if (!keys || files.length === 0) return;
    const ctx: UploadContext = { tripId, ...keys };
    const failures: string[] = [];
    setError(null);
    for (let i = 0; i < files.length; i++) {
      const file = files[i] as File;
      setProgress({ done: i, total: files.length, current: file.name });
      try {
        await each(file, ctx);
      } catch (e) {
        failures.push(
          e instanceof FileTooLargeError ? e.message : `${file.name}: upload failed, try again.`,
        );
      }
    }
    setProgress(null);
    if (failures.length > 0) setError(failures.join(' '));
  }
  return { run, progress, error, busy: progress !== null };
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
  const input = useRef<HTMLInputElement>(null);
  const { run, progress, error, busy } = useUploader();

  const onFiles = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (input.current) input.current.value = '';
    const added: Attachment[] = [];
    await run(files, async (file, ctx) => {
      added.push(await uploadAttachment(file, ctx));
    });
    if (added.length === 0) return;
    // Patch once with everything that uploaded; a failed save shows in the sheet's status line.
    await actions
      .patchEvent(event.id, { attachments: [...event.attachments, ...added] })
      .catch(() => undefined);
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
      <Button onClick={() => input.current?.click()} disabled={busy}>
        Attach
      </Button>
      <Status progress={progress} error={error} />
    </>
  );
}

/** Create one receipt event per picked or captured file. */
export function AddReceiptButton() {
  const actions = useTripActions();
  const input = useRef<HTMLInputElement>(null);
  const { run, progress, error, busy } = useUploader();

  const onFiles = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (input.current) input.current.value = '';
    await run(files, async (file, ctx) => {
      const attachment = await uploadAttachment(file, ctx);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await actions.putEvent({
        type: 'receipt',
        name: receiptName(file.name),
        start: fromInstant(Date.now(), tz),
        attachments: [attachment],
      });
    });
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*,application/pdf"
        capture="environment"
        multiple
        hidden
        data-testid="receipt-input"
        onChange={(e) => void onFiles(e.target.files)}
      />
      <Button onClick={() => input.current?.click()} disabled={busy}>
        Add receipt
      </Button>
      <Status progress={progress} error={error} />
    </>
  );
}
