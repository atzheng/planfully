import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from '../ui/IconButton';
import styles from './SheetHeader.module.css';

/** Shared chrome for the event and add sheets: optional leading icon, title, quiet subtitle, close. */
export function SheetHeader({
  icon,
  type,
  title,
  subtitle,
  badges,
  onClose,
}: {
  icon?: ReactNode;
  /** Sets data-type so the icon tile takes the type colours. */
  type?: string;
  title: string;
  subtitle?: ReactNode;
  badges?: ReactNode;
  onClose: () => void;
}) {
  return (
    <header className={styles.header}>
      {icon && (
        <span className={styles.tile} data-type={type}>
          {icon}
        </span>
      )}
      <div className={styles.text}>
        <h2 className={styles.title}>{title}</h2>
        {(subtitle || badges) && (
          <div className={styles.sub}>
            {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
            {badges}
          </div>
        )}
      </div>
      <IconButton label="Close" onClick={onClose} className={styles.close}>
        <X size={18} aria-hidden="true" />
      </IconButton>
    </header>
  );
}
