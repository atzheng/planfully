import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Event } from '@planfully/shared';
import {
  allZones,
  cityName,
  offsetLabel,
  referenceMs,
  sameZone,
  searchZones,
  zoneOptions,
  zoneSummary,
} from './zones';
import { ZoneSearchList } from './ZoneSearchList';
import styles from './TimeZonePicker.module.css';

/**
 * Display-zone picker for the timeline toolbar. `zone` is the active zone; `onChange` receives an
 * IANA zone, or '' for "Your time" (which removes `tz` from the URL).
 */
export function TimeZonePicker({
  zone,
  browserZone,
  events,
  onChange,
  compact,
  open: openProp,
  onOpenChange,
}: {
  zone: string;
  browserZone: string;
  events: readonly Event[];
  onChange: (tz: string) => void;
  /** Tiny trigger showing only the UTC offset (for the canvas corner). */
  compact?: boolean;
  /** Controlled open state; the picker manages its own when omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (o: boolean) => {
    setOpenState(o);
    onOpenChange?.(o);
  };
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popId = useId();

  const atMs = useMemo(() => referenceMs(events, Date.now()), [events]);
  const options = useMemo(
    () => zoneOptions(events, browserZone, atMs),
    [events, browserZone, atMs],
  );
  const zones = useMemo(() => (searching ? allZones() : []), [searching]);
  const results = useMemo(() => searchZones(query, zones), [query, zones]);

  const items = useMemo(
    () =>
      results.map((z) => ({
        value: sameZone(z, browserZone) ? '' : z,
        name: cityName(z),
        meta: `${z.split('/')[0]} · ${offsetLabel(z, atMs)}`,
      })),
    [results, browserZone, atMs],
  );

  const close = (refocus: boolean) => {
    setOpen(false);
    setSearching(false);
    setQuery('');
    if (refocus) trigger.current?.focus();
  };

  useEffect(() => {
    const el = root.current;
    if (!open || !el) return;
    const onDown = (ev: PointerEvent) => {
      if (!el.contains(ev.target as Node)) close(false);
    };
    // On the wrapper (not document) so an open event sheet does not also see this Escape.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', onDown);
    el.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      el.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const sel = searching ? 'input' : '[aria-current=true], [data-testid=tz-option]';
    root.current?.querySelector<HTMLElement>(sel)?.focus();
  }, [open, searching]);

  const pick = (tz: string) => {
    onChange(tz);
    close(true);
  };
  const summary = zoneSummary(zone, atMs);
  const inList = options.some((o) =>
    o.isBrowser ? sameZone(zone, browserZone) : sameZone(o.value, zone),
  );

  return (
    <div className={styles.root} ref={root}>
      <button
        ref={trigger}
        type="button"
        className={`${styles.trigger} ${compact ? styles.compact : ''}`}
        data-testid="tz-trigger"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-label={`Time zone: ${summary}. Change`}
        onClick={() => (open ? close(true) : setOpen(true))}
      >
        {compact ? (
          <span className={styles.summary}>{offsetLabel(zone, atMs)}</span>
        ) : (
          <>
            <span aria-hidden="true">🌐</span>
            <span className={styles.summary}>{summary}</span>
          </>
        )}
      </button>
      {open && (
        <div
          className={styles.pop}
          id={popId}
          role="group"
          aria-label="Time zone"
          data-testid="tz-pop"
        >
          {!searching ? (
            <ul className={styles.list}>
              {options.map((o) => {
                const active = o.isBrowser ? sameZone(zone, browserZone) : sameZone(o.value, zone);
                return (
                  <li key={o.value || 'browser'}>
                    <button
                      type="button"
                      className={`${styles.item} ${active ? styles.active : ''}`}
                      data-testid="tz-option"
                      aria-current={active}
                      onClick={() => pick(o.value)}
                    >
                      <span className={styles.itemName}>{o.isBrowser ? 'Your time' : o.city}</span>
                      <span className={styles.itemMeta}>
                        {o.isBrowser ? `${o.city} · ${o.offset}` : o.offset}
                      </span>
                    </button>
                  </li>
                );
              })}
              {!inList && (
                <li>
                  <button
                    type="button"
                    className={`${styles.item} ${styles.active}`}
                    data-testid="tz-option"
                    aria-current={true}
                    onClick={() => pick(zone)}
                  >
                    <span className={styles.itemName}>{cityName(zone)}</span>
                    <span className={styles.itemMeta}>{offsetLabel(zone, atMs)}</span>
                  </button>
                </li>
              )}
              <li>
                <button
                  type="button"
                  className={styles.item}
                  data-testid="tz-other"
                  onClick={() => setSearching(true)}
                >
                  <span className={styles.itemName}>Other…</span>
                </button>
              </li>
            </ul>
          ) : (
            <div className={styles.search}>
              <ZoneSearchList
                label="Search time zones"
                query={query}
                onQueryChange={setQuery}
                items={items}
                onPick={pick}
                emptyText={query.trim() !== '' ? 'No matching zone.' : undefined}
                inputTestId="tz-search"
                itemTestId="tz-result"
              />
              <button type="button" className={styles.back} onClick={() => setSearching(false)}>
                Back
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
