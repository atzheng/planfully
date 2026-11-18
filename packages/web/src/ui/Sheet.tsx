import { useEffect, useRef, type ReactNode } from 'react';
import { focusInitial, trapTab } from './focusTrap';
import styles from './ui.module.css';

/**
 * Bottom sheet on phones, centred dialog or side panel on desktop. Always
 * modal: even the `side` variant renders a full-screen backdrop that closes on
 * click, so focus is moved in on open, trapped, and restored on close.
 */
export function Sheet({
  open,
  onClose,
  label,
  side,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** Accessible name (aria-label). */
  label: string;
  /** Right-hand panel on desktop (phones still get a bottom sheet). */
  side?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) focusInitial(dialog);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      else if (dialogRef.current) trapTab(e, dialogRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (previous && previous.isConnected) previous.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      className={[styles.backdrop, side ? styles.sideBackdrop : ''].join(' ').trim()}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={[styles.sheet, side ? styles.side : ''].join(' ').trim()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.handle} aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}
