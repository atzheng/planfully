const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/** Move focus into `root`: first focusable, else the root itself (needs tabIndex=-1). */
export function focusInitial(root: HTMLElement): void {
  (focusableIn(root)[0] ?? root).focus();
}

/**
 * Handle a Tab keydown so focus wraps inside `root`. Returns true when it
 * redirected focus (preventDefault is already called).
 */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  if (e.key !== 'Tab') return false;
  const items = focusableIn(root);
  const active = document.activeElement;
  if (items.length === 0) {
    e.preventDefault();
    root.focus();
    return true;
  }
  const first = items[0] as HTMLElement;
  const last = items[items.length - 1] as HTMLElement;
  const outside = !active || !root.contains(active) || active === root;
  if (e.shiftKey && (active === first || outside)) {
    e.preventDefault();
    last.focus();
    return true;
  }
  if (!e.shiftKey && (active === last || outside)) {
    e.preventDefault();
    first.focus();
    return true;
  }
  return false;
}
