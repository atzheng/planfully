import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { buttonClass, type ButtonSize, type ButtonVariant } from './Button';

/** Icon-only button (ghost by default); `label` is the required accessible name and tooltip. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
    label: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
  }
>(function IconButton(
  { label, variant = 'ghost', size, className, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={buttonClass({ variant, size, iconOnly: true, className })}
      {...rest}
    >
      {children}
    </button>
  );
});
