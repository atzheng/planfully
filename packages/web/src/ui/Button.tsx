import type { ButtonHTMLAttributes } from 'react';
import styles from './ui.module.css';

export function Button({
  primary,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  const cls = [styles.button, primary ? styles.primary : '', className ?? ''].join(' ').trim();
  return <button type="button" className={cls} {...rest} />;
}
