import type { ButtonHTMLAttributes } from 'react';
import styles from './ui.module.css';

/** Icon-only button; `label` is required for accessibility. */
export function IconButton({
  label,
  className,
  children,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={[styles.icon, className ?? ''].join(' ').trim()}
      {...rest}
    >
      {children}
    </button>
  );
}
