import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { focusInitial } from './focusTrap';
import styles from './ui.module.css';

export type Rect = { top: number; left: number; right: number; bottom: number };
export type Align = 'start' | 'end';

/**
 * Pure placement: below the anchor (above when there is no room below and more room above),
 * aligned to its start or end edge, clamped to the viewport with `margin` px to spare.
 */
export function placePopover(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: { align?: Align; gap?: number; margin?: number } = {},
): { top: number; left: number; placement: 'below' | 'above' } {
  const { align = 'start', gap = 4, margin = 8 } = opts;
  const roomBelow = viewport.height - anchor.bottom - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  const placement = size.height > roomBelow && roomAbove > roomBelow ? 'above' : 'below';
  const rawTop = placement === 'below' ? anchor.bottom + gap : anchor.top - gap - size.height;
  const top = Math.max(margin, Math.min(rawTop, viewport.height - margin - size.height));
  const rawLeft = align === 'end' ? anchor.right - size.width : anchor.left;
  const left = Math.max(margin, Math.min(rawLeft, viewport.width - margin - size.width));
  return { top, left, placement };
}

/**
 * Anchored floating panel, controlled by `open`. Closes on Escape (only while focus is in the
 * popover or on the anchor; the key is not passed on, so an enclosing Sheet stays open) and on a
 * pointer press outside both. Focus moves in on open (unless `autoFocus` is false) and returns to
 * the anchor on close. Rendered in a portal so it is never clipped.
 */
export function Popover({
  open,
  onClose,
  anchorRef,
  label,
  role = 'dialog',
  align = 'start',
  autoFocus = true,
  padded = true,
  onKeyDown,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** Accessible name. */
  label: string;
  role?: 'dialog' | 'menu';
  align?: Align;
  autoFocus?: boolean;
  /** Inner padding for free-form content (menus turn it off). */
  padded?: boolean;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Place after layout, and again when the viewport changes.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const el = ref.current;
      const anchor = anchorRef.current;
      if (!el || !anchor) return;
      const r = anchor.getBoundingClientRect();
      const { top, left } = placePopover(
        r,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        { align },
      );
      setPos((p) => (p && p.top === top && p.left === left ? p : { top, left }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, align, anchorRef, children]);

  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const el = ref.current;
    if (autoFocus && el && !el.contains(document.activeElement)) focusInitial(el);
    const onPointerDown = (e: PointerEvent | MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (ref.current?.contains(t) || anchor?.contains(t))) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const a = document.activeElement;
      if (a && a !== document.body && !ref.current?.contains(a) && !anchor?.contains(a)) return;
      e.stopPropagation();
      onCloseRef.current();
    };
    // Capture phase so this wins over the window-level Escape of an enclosing Sheet.
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
      if (
        anchor?.isConnected &&
        (!document.activeElement ||
          document.activeElement === document.body ||
          el?.contains(document.activeElement))
      ) {
        anchor.focus();
      }
    };
  }, [open, autoFocus, anchorRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      tabIndex={-1}
      className={[styles.popover, padded ? styles.popoverPanel : '', className ?? '']
        .join(' ')
        .trim()}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}
