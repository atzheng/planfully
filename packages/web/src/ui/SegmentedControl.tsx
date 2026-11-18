import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import styles from './ui.module.css';

export type Segment<T extends string> = {
  value: T;
  label: ReactNode;
  /** Accessible name when `label` is an icon. */
  ariaLabel?: string;
  testId?: string;
};

/** Index to move to for an arrow/Home/End key (wraps), or null for other keys. Pure. */
export function nextSegmentIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * Single-choice control (radio group). Roving tabindex: Tab enters on the selected segment, arrow
 * keys move AND select, Home/End jump.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
  className,
}: {
  options: readonly Segment<T>[];
  value: T;
  onChange: (v: T) => void;
  /** Accessible name of the group. */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = nextSegmentIndex(e.key, index, options.length);
    if (next === null) return;
    e.preventDefault();
    const opt = options[next];
    if (!opt) return;
    onChange(opt.value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={[styles.segmented, size === 'sm' ? styles.segmentedSm : '', className ?? '']
        .join(' ')
        .trim()}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-label={o.ariaLabel}
          data-testid={o.testId}
          tabIndex={i === selected ? 0 : -1}
          className={styles.segment}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
