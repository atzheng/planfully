import { forwardRef, type ButtonHTMLAttributes } from 'react';
import styles from './ui.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

type Base = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Legacy shorthand for variant="primary". */
  primary?: boolean;
  /** Floating action button: round, raised, fixed bottom-right (override position with className). Needs an aria-label. */
  fab?: boolean;
};
export type ButtonProps =
  | (Base & { iconOnly?: false; 'aria-label'?: string })
  /** Icon-only buttons have no text, so the accessible name is required. */
  | (Base & { iconOnly: true; 'aria-label': string });

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: styles.primary ?? '',
  secondary: styles.secondary ?? '',
  ghost: styles.ghost ?? '',
  danger: styles.danger ?? '',
};

export function buttonClass(opts: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  fab?: boolean;
  className?: string;
}): string {
  return [
    styles.button,
    VARIANT_CLASS[opts.fab ? 'primary' : (opts.variant ?? 'secondary')],
    opts.size === 'sm' ? styles.sm : '',
    opts.iconOnly ? styles.iconOnly : '',
    opts.fab ? styles.fab : '',
    opts.className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, primary, fab, iconOnly, className, type = 'button', ...rest },
  ref,
) {
  const v = variant ?? (primary ? 'primary' : 'secondary');
  const icon = iconOnly || fab;
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass({ variant: v, size, iconOnly: icon, fab, className })}
      {...rest}
    />
  );
});
