import { useEffect, useId, useRef, useState } from 'react';
import type { Location } from '@planfully/shared';
import * as api from '../lib/api';
import { useTrip } from '../trip/store';
import styles from './PlaceSearch.module.css';

export const SEARCH_DELAY_MS = 300;
const MIN_QUERY = 3;

type State = { kind: 'idle' } | { kind: 'loading' } | { kind: 'done'; results: Location[] };

/**
 * Text input that looks places up through /api/geocode as the user types. Picking a result hands
 * the whole place to `onPick`; free text always stays possible (no server key gives no results).
 */
export function PlaceSearch({
  id,
  value,
  onChange,
  onPick,
}: {
  id: string;
  value: string;
  /** Called for typing; the parent decides what that does to coordinates. */
  onChange: (text: string) => void;
  onPick: (place: Location) => void;
}) {
  const tripId = useTrip((s) => s.tripId);
  const accessToken = useTrip((s) => s.keys?.accessToken);
  const listId = useId();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [closed, setClosed] = useState(false);
  const [active, setActive] = useState(-1);
  /** Only text the user typed is searched, not the value the form opened with or a picked place. */
  const typed = useRef(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!typed.current) return;
    const q = value.trim();
    const mine = ++seq.current;
    if (q.length < MIN_QUERY || !accessToken) {
      setState({ kind: 'idle' });
      return;
    }
    setState({ kind: 'loading' });
    const t = setTimeout(() => {
      api.geocode({ tripId, accessToken }, q).then(
        (r) => {
          if (seq.current === mine) setState({ kind: 'done', results: r.results });
        },
        () => {
          // Offline or the server is unreachable: same as no results, free text still works.
          if (seq.current === mine) setState({ kind: 'done', results: [] });
        },
      );
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [value, tripId, accessToken]);

  const results = state.kind === 'done' ? state.results : [];
  const open = !closed && state.kind === 'done' && results.length > 0;

  const pick = (r: Location) => {
    typed.current = false;
    seq.current++;
    setState({ kind: 'idle' });
    setActive(-1);
    onPick(r);
  };

  return (
    <div className={styles.wrap}>
      <input
        id={id}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 && open ? `${listId}-${active}` : undefined}
        value={value}
        onChange={(e) => {
          typed.current = true;
          setClosed(false);
          setActive(-1);
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => (i + 1) % results.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (i <= 0 ? results.length - 1 : i - 1));
          } else if (e.key === 'Enter' && active >= 0) {
            e.preventDefault();
            pick(results[active]!);
          } else if (e.key === 'Escape') {
            // Close the list, not the surrounding sheet (Sheet listens on window).
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation();
            setClosed(true);
          }
        }}
      />
      <ul id={listId} role="listbox" className={styles.list} hidden={!open}>
        {results.map((r, i) => (
          <li
            key={r.placeId ?? `${r.lat},${r.lng},${i}`}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            className={`${styles.option} ${i === active ? styles.active : ''}`}
            // mousedown, not click: the input's blur must not close the list first.
            onMouseDown={(e) => {
              e.preventDefault();
              pick(r);
            }}
          >
            <span className={styles.name}>{r.name ?? r.address}</span>
            {r.name && r.address && <span className={styles.addr}>{r.address}</span>}
          </li>
        ))}
      </ul>
      {!closed && state.kind === 'done' && results.length === 0 && (
        <p role="status" className={styles.note}>
          No results. What you typed is kept as written.
        </p>
      )}
      {!closed && state.kind === 'loading' && (
        <p role="status" className={styles.note}>
          Searching...
        </p>
      )}
    </div>
  );
}
