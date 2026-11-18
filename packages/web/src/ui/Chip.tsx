import type { ButtonHTMLAttributes } from 'react';
import styles from './ui.module.css';

/** Toggle chip: a pressed/unpressed filter-style button (aria-pressed). */
export function Chip({
  selected,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  const cls = [styles.chip, selected ? styles.selected : '', className ?? ''].join(' ').trim();
  return <button type="button" aria-pressed={selected ?? false} className={cls} {...rest} />;
}

export { Chip as ToggleChip };
