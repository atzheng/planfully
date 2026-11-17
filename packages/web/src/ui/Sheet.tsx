import { useEffect, type ReactNode } from 'react';
import styles from './ui.module.css';

/** Bottom sheet on phones, centred dialog on desktop. */
export function Sheet({
  open,
  onClose,
  label,
  side,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  /** Right-hand panel on desktop (phones still get a bottom sheet). */
  side?: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className={[styles.backdrop, side ? styles.sideBackdrop : ''].join(' ').trim()}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={[styles.sheet, side ? styles.side : ''].join(' ').trim()}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
