import type { HTMLAttributes } from 'react';
import styles from './ui.module.css';

export type BadgeTone = 'neutral' | 'accent' | 'danger' | 'warning' | 'success';

const TONE: Record<BadgeTone, string> = {
  neutral: '',
  accent: styles.badgeAccent ?? '',
  danger: styles.badgeDanger ?? '',
  warning: styles.badgeWarning ?? '',
  success: styles.badgeSuccess ?? '',
};

/** Small count / status pill, e.g. the number of active filters. */
export function Badge({
  tone = 'neutral',
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span className={[styles.badge, TONE[tone], className ?? ''].join(' ').trim()} {...rest} />
  );
}
