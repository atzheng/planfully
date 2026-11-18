import { useEffect, useRef, useState } from 'react';
import { Ban, Check, ListFilter, Search, X } from 'lucide-react';
import { EVENT_TYPES, type EventType } from '@planfully/shared';
import { useTrip } from '../trip/store';
import { Badge } from '../ui/Badge';
import { Button, type ButtonSize } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Input } from '../ui/Input';
import { Popover } from '../ui/Popover';
import { Sheet } from '../ui/Sheet';
import {
  NEXT_CHIP_STATE,
  activeFilterCount,
  chipState,
  filterEvents,
  isFilterActive,
  withChipState,
  type ChipState,
  type FilterApi,
} from './filter';
import styles from './FilterControls.module.css';

const PHONE_QUERY = '(max-width: 719px)';

export function useIsPhone(): boolean {
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

const STATE_WORD: Record<ChipState, string> = {
  none: 'not filtered',
  include: 'included',
  exclude: 'excluded',
};
const NEXT_ACTION: Record<ChipState, string> = {
  none: 'include',
  include: 'exclude',
  exclude: 'clear',
};

/**
 * Three-state filter chip: none -> include -> exclude -> none. The state shows in the icon and
 * strike-through as well as the colour; the aria-label gives the state and what a press does.
 */
function TriChip({
  state,
  name,
  onChange,
}: {
  state: ChipState;
  name: string;
  onChange: (next: ChipState) => void;
}) {
  const cls = [
    styles.tri,
    state === 'include' ? styles.inc : '',
    state === 'exclude' ? styles.exc : '',
  ]
    .join(' ')
    .trim();
  return (
    <button
      type="button"
      className={cls}
      data-state={state}
      aria-label={`${name}: ${STATE_WORD[state]}. Activate to ${NEXT_ACTION[state]}`}
      onClick={() => onChange(NEXT_CHIP_STATE[state])}
    >
      {state === 'include' && <Check size={14} aria-hidden="true" />}
      {state === 'exclude' && <Ban size={14} aria-hidden="true" />}
      <span className={styles.triText}>{name}</span>
    </button>
  );
}

/** Search field that replaces the app bar contents while open. */
export function SearchField({ api, onClose }: { api: FilterApi; onClose: () => void }) {
  const { filter, setFilter } = api;
  // Local copy keeps the caret stable while typing; the URL follows and drives external changes.
  const [qText, setQText] = useState(filter.q);
  useEffect(() => setQText(filter.q), [filter.q]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div className={styles.search} role="search">
      <Search size={16} className={styles.searchIcon} aria-hidden="true" />
      <Input
        ref={input}
        type="search"
        className={styles.searchInput}
        aria-label="Search events"
        placeholder="Search name, place, confirmation"
        value={qText}
        onChange={(e) => {
          setQText(e.target.value);
          setFilter({ q: e.target.value });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      />
      <IconButton label="Close search" onClick={onClose}>
        <X size={18} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

function Panel({ api, onDone }: { api: FilterApi; onDone?: () => void }) {
  const roster = useTrip((s) => s.meta?.roster);
  const events = useTrip((s) => s.events);
  const { filter, setFilter, clear } = api;
  const shown = filterEvents(events, filter).length;
  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <h3 className={styles.heading}>Type</h3>
        <div className={styles.group} role="group" aria-label="Types">
          {EVENT_TYPES.map((t: EventType) => (
            <TriChip
              key={t}
              name={label(t)}
              state={chipState(filter.types, filter.excludeTypes, t)}
              onChange={(next) => {
                const r = withChipState(filter.types, filter.excludeTypes, t, next);
                setFilter({ types: r.include, excludeTypes: r.exclude });
              }}
            />
          ))}
        </div>
      </section>
      {roster && roster.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Who</h3>
          <div className={styles.group} role="group" aria-label="Participants">
            {roster.map((m) => (
              <TriChip
                key={m.id}
                name={m.name}
                state={chipState(filter.who, filter.excludeWho, m.id)}
                onChange={(next) => {
                  const r = withChipState(filter.who, filter.excludeWho, m.id, next);
                  setFilter({ who: r.include, excludeWho: r.exclude });
                }}
              />
            ))}
          </div>
        </section>
      )}
      <section className={styles.section}>
        <h3 className={styles.heading}>Dates</h3>
        <div className={styles.dates}>
          <label className={styles.field}>
            <span>From</span>
            <Input
              type="date"
              value={filter.from ?? ''}
              max={filter.to}
              onChange={(e) => setFilter({ from: e.target.value || undefined })}
            />
          </label>
          <label className={styles.field}>
            <span>To</span>
            <Input
              type="date"
              value={filter.to ?? ''}
              min={filter.from}
              onChange={(e) => setFilter({ to: e.target.value || undefined })}
            />
          </label>
        </div>
      </section>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={filter.cancelled}
          onChange={(e) => setFilter({ cancelled: e.target.checked })}
        />
        Show cancelled
      </label>
      <div className={styles.footer}>
        <span className={styles.count} role="status">
          {shown} of {events.length} events
        </span>
        <Button size="sm" onClick={clear} disabled={!isFilterActive(filter)}>
          Clear all
        </Button>
        {onDone && (
          <Button primary onClick={onDone}>
            Show {shown} {shown === 1 ? 'event' : 'events'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Filters icon with a count badge. A popover on desktop, a bottom sheet on phones. */
export function FilterButton({
  api,
  phone,
  size,
  className,
}: {
  api: FilterApi;
  phone: boolean;
  size?: ButtonSize;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  // The search text has its own affordance; the badge counts the other criteria.
  const n = activeFilterCount({ ...api.filter, q: '' });
  return (
    <>
      <span className={styles.anchor}>
        <IconButton
          ref={anchor}
          size={size}
          className={className}
          label={n > 0 ? `Filters, ${n} active` : 'Filters'}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <ListFilter size={18} aria-hidden="true" />
        </IconButton>
        {n > 0 && (
          <Badge tone="accent" className={styles.badge} aria-hidden="true">
            {n}
          </Badge>
        )}
      </span>
      {phone ? (
        <Sheet open={open} onClose={() => setOpen(false)} label="Filters">
          <Panel api={api} onDone={() => setOpen(false)} />
        </Sheet>
      ) : (
        <Popover
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={anchor}
          label="Filters"
          align="end"
          className={styles.popover}
        >
          <Panel api={api} />
        </Popover>
      )}
    </>
  );
}
