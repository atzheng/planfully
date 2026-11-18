import {
  forwardRef,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import styles from './ui.module.css';

const cls = (base: string | undefined, invalid?: boolean, extra?: string) =>
  [base, invalid ? styles.invalid : '', extra ?? ''].filter(Boolean).join(' ');

/** Text input. 16px on phones (see theme.css) so iOS does not zoom on focus. */
export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function Input({ invalid, className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cls(styles.input, invalid, className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ invalid, className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cls(styles.textarea, invalid, className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

/** Styled native select (keeps the platform picker on phones). */
export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(function Select({ invalid, className, ...rest }, ref) {
  return (
    <select
      ref={ref}
      className={cls(styles.select, invalid, className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});
