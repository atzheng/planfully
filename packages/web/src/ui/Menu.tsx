import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { Check } from 'lucide-react';
import { Popover, type Align } from './Popover';
import styles from './ui.module.css';

export type MenuItem =
  | {
      label: string;
      icon?: ReactNode;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
      /** When set the item is a checkbox-style option (aria-checked). */
      checked?: boolean;
      /** Keep the menu open after selecting. */
      keepOpen?: boolean;
      testId?: string;
    }
  | { separator: true };

export type MenuTriggerProps = {
  ref: Ref<HTMLButtonElement>;
  id: string;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls'?: string;
};

/** Next enabled index for an arrow/Home/End key, wrapping; null for other keys. Pure. */
export function nextMenuIndex(
  key: string,
  current: number,
  enabled: readonly boolean[],
): number | null {
  const n = enabled.length;
  if (n === 0 || !enabled.some(Boolean)) return null;
  const step = (from: number, dir: 1 | -1) => {
    let i = from;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (enabled[i]) return i;
    }
    return null;
  };
  if (key === 'ArrowDown') return step(current, 1);
  if (key === 'ArrowUp') return step(current < 0 ? 0 : current, -1);
  if (key === 'Home') return enabled.findIndex(Boolean);
  if (key === 'End') return enabled.lastIndexOf(true);
  return null;
}

/**
 * Action menu. `trigger` renders the button (spread the props onto it: ref, handlers and ARIA).
 * Arrow keys / Home / End move between items, Enter or Space selects, Escape closes and returns
 * focus to the trigger, Tab closes, a press outside closes. ArrowDown on the closed trigger opens it.
 */
export function Menu({
  items,
  trigger,
  label,
  align = 'end',
}: {
  items: readonly MenuItem[];
  trigger: (props: MenuTriggerProps) => ReactNode;
  /** Accessible name of the menu. */
  label: string;
  align?: Align;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = () => setOpen(false);
  const buttons = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? []);

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Tab') {
      // Close and return focus to the trigger; keep the key from an enclosing Sheet's focus trap.
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const els = buttons();
    const current = els.indexOf(document.activeElement as HTMLButtonElement);
    const next = nextMenuIndex(
      e.key,
      current,
      els.map((b) => !b.disabled),
    );
    if (next === null) return;
    e.preventDefault();
    els[next]?.focus();
  }

  return (
    <>
      {trigger({
        ref: anchorRef,
        id: `${id}-trigger`,
        onClick: () => setOpen((o) => !o),
        onKeyDown: (e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            setOpen(true);
          }
        },
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? `${id}-menu` : undefined,
      })}
      <Popover
        open={open}
        onClose={close}
        anchorRef={anchorRef}
        label={label}
        role="menu"
        id={`${id}-menu`}
        align={align}
        padded={false}
        onKeyDown={onListKeyDown}
      >
        <div ref={listRef} role="none">
          {items.map((item, i) =>
            'separator' in item ? (
              <div key={`sep-${i}`} role="separator" className={styles.menuSep} />
            ) : (
              <button
                key={`${i}-${item.label}`}
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked}
                disabled={item.disabled}
                data-testid={item.testId}
                className={[styles.menuItem, item.danger ? styles.menuDanger : ''].join(' ').trim()}
                onClick={() => {
                  if (!item.keepOpen) close();
                  item.onSelect();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.checked && (
                  <Check size={16} className={styles.menuCheck} aria-hidden="true" />
                )}
              </button>
            ),
          )}
        </div>
      </Popover>
    </>
  );
}
