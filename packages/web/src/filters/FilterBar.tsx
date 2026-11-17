import { useEffect, useState } from 'react';
import { EVENT_TYPES, type EventType } from '@planfully/shared';
import { useTrip } from '../trip/store';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { Sheet } from '../ui/Sheet';
import {
  activeFilterCount,
  filterEvents,
  isFilterActive,
  useFilterState,
  type FilterApi,
} from './filter';
import styles from './FilterBar.module.css';

const PHONE_QUERY = '(max-width: 719px)';

function useIsPhone(): boolean {
  const hasMq = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
  const [phone, setPhone] = useState(() =>
    hasMq ? window.matchMedia(PHONE_QUERY).matches : false,
  );
  useEffect(() => {
    if (!hasMq) return;
    const mq = window.matchMedia(PHONE_QUERY);
    const on = () => setPhone(mq.matches);
    mq.addEventListener('change', on);
    on();
    return () => mq.removeEventListener('change', on);
  }, [hasMq]);
  return phone;
}

const label = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const toggle = <T,>(list: readonly T[], v: T): T[] =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

function Controls({ api }: { api: FilterApi }) {
  const roster = useTrip((s) => s.meta?.roster);
  const { filter, setFilter } = api;
  // Local copy keeps the caret stable while typing; the URL follows and drives external changes.
  const [qText, setQText] = useState(filter.q);
  useEffect(() => setQText(filter.q), [filter.q]);
  return (
    <div className={styles.controls}>
      <input
        type="search"
        className={styles.search}
        aria-label="Search events"
        placeholder="Search name, place, confirmation"
        value={qText}
        onChange={(e) => {
          setQText(e.target.value);
          setFilter({ q: e.target.value });
        }}
      />
      <div className={styles.group} role="group" aria-label="Types">
        {EVENT_TYPES.map((t: EventType) => (
          <Chip
            key={t}
            selected={filter.types.includes(t)}
            onClick={() => setFilter({ types: toggle(filter.types, t) })}
          >
            {label(t)}
          </Chip>
        ))}
      </div>
      <div className={styles.dates}>
        <label className={styles.field}>
          <span>From</span>
          <input
            type="date"
            value={filter.from ?? ''}
            max={filter.to}
            onChange={(e) => setFilter({ from: e.target.value || undefined })}
          />
        </label>
        <label className={styles.field}>
          <span>To</span>
          <input
            type="date"
            value={filter.to ?? ''}
            min={filter.from}
            onChange={(e) => setFilter({ to: e.target.value || undefined })}
          />
        </label>
      </div>
      {roster && roster.length > 0 && (
        <div className={styles.group} role="group" aria-label="Participants">
          {roster.map((m) => (
            <Chip
              key={m.id}
              selected={filter.who.includes(m.id)}
              onClick={() => setFilter({ who: toggle(filter.who, m.id) })}
            >
              {m.name}
            </Chip>
          ))}
        </div>
      )}
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={filter.cancelled}
          onChange={(e) => setFilter({ cancelled: e.target.checked })}
        />
        Show cancelled
      </label>
    </div>
  );
}

export function FilterBar() {
  const api = useFilterState();
  const events = useTrip((s) => s.events);
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const { filter, clear } = api;
  const shown = filterEvents(events, filter).length;
  const active = isFilterActive(filter);
  const count = (
    <span className={styles.count} role="status">
      {shown} of {events.length} events
    </span>
  );
  const clearBtn = (
    <Button onClick={clear} disabled={!active}>
      Clear all
    </Button>
  );

  if (phone) {
    const n = activeFilterCount(filter);
    return (
      <div className={styles.bar}>
        <Button onClick={() => setOpen(true)}>Filters{n > 0 ? ` (${n})` : ''}</Button>
        {count}
        <Sheet open={open} onClose={() => setOpen(false)} label="Filters">
          <Controls api={api} />
          <div className={styles.sheetActions}>
            {clearBtn}
            <Button className={styles.done} onClick={() => setOpen(false)}>
              Show {shown} {shown === 1 ? 'event' : 'events'}
            </Button>
          </div>
        </Sheet>
      </div>
    );
  }
  return (
    <div className={styles.bar}>
      <Controls api={api} />
      <div className={styles.row}>
        {count}
        {clearBtn}
      </div>
    </div>
  );
}
