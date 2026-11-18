import { useId, type ReactNode } from 'react';
import styles from './ui.module.css';

export type FieldControlProps = {
  id: string;
  'aria-describedby'?: string;
  invalid?: boolean;
  required?: boolean;
};

/**
 * Label + control + hint + error. The control is a render function so the label, hint and error are
 * wired to it: `<Field label="Name">{(p) => <Input {...p} />}</Field>`.
 */
export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: (props: FieldControlProps) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={[styles.field, className ?? ''].join(' ').trim()}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        invalid: error ? true : undefined,
        required,
      })}
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
