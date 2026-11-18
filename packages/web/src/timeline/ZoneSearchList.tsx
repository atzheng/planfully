import { useEffect, useId, useRef, useState } from 'react';
import styles from './ZoneSearchList.module.css';

export type ZoneItem = {
  /** Value passed to onPick. */
  value: string;
  name: string;
  meta?: string;
  /** Marks the current selection. */
  active?: boolean;
};

/**
 * Search box plus a listbox of zones, shared by the timeline's zone picker and the event form.
 * The input keeps focus; ArrowUp/Down move the highlighted row and Enter picks it. Escape and Tab
 * are left to the enclosing popover.
 */
export function ZoneSearchList({
  label,
  query,
  onQueryChange,
  items,
  onPick,
  emptyText,
  inputTestId,
  itemTestId,
  placeholder = 'Search city or region',
}: {
  /** Accessible name of the search box. */
  label: string;
  query: string;
  onQueryChange: (q: string) => void;
  items: readonly ZoneItem[];
  onPick: (value: string) => void;
  /** Shown when `items` is empty. */
  emptyText?: string;
  inputTestId?: string;
  itemTestId?: string;
  placeholder?: string;
}) {
  const uid = useId();
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const n = items.length;
  const cur = n === 0 ? -1 : Math.min(hi, n - 1);

  useEffect(() => setHi(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' });
  }, [cur]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (n > 0) setHi((cur + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter') {
      e.preventDefault(); // never submits the enclosing form
      const it = items[cur];
      if (it) onPick(it.value);
    }
  };

  return (
    <div className={styles.root}>
      <input
        type="search"
        role="combobox"
        aria-expanded="true"
        aria-controls={`${uid}-list`}
        aria-activedescendant={cur >= 0 ? `${uid}-${cur}` : undefined}
        aria-autocomplete="list"
        className={styles.input}
        data-testid={inputTestId}
        placeholder={placeholder}
        aria-label={label}
        value={query}
        autoComplete="off"
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <ul
        id={`${uid}-list`}
        role="listbox"
        aria-label="Matching time zones"
        ref={listRef}
        className={styles.list}
      >
        {items.map((it, i) => (
          <li
            key={it.value || 'browser'}
            id={`${uid}-${i}`}
            role="option"
            aria-selected={i === cur}
            aria-current={it.active || undefined}
            data-testid={itemTestId}
            className={[styles.item, i === cur ? styles.hi : '', it.active ? styles.active : '']
              .join(' ')
              .trim()}
            onMouseMove={() => i !== cur && setHi(i)}
            // Keep focus in the input so the keyboard flow is not interrupted.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(it.value)}
          >
            <span className={styles.name}>{it.name}</span>
            {it.meta && <span className={styles.meta}>{it.meta}</span>}
          </li>
        ))}
        {n === 0 && emptyText && (
          <li className={styles.none} role="status">
            {emptyText}
          </li>
        )}
      </ul>
    </div>
  );
}
