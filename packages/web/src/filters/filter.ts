import { useMemo } from 'react';
import { EVENT_TYPES, type Event, type EventType } from '@planfully/shared';
import {
  booleanCodec,
  dateCodec,
  stringCodec,
  stringListCodec,
  useQueryState,
} from '../lib/queryState';
import { useTrip } from '../trip/store';

export type Filter = {
  q: string;
  types: EventType[];
  /** 'YYYY-MM-DD', inclusive */
  from?: string;
  /** 'YYYY-MM-DD', inclusive */
  to?: string;
  who: string[];
  cancelled: boolean;
};

export function isFilterActive(f: Filter): boolean {
  return (
    f.q.trim() !== '' || f.types.length > 0 || !!f.from || !!f.to || f.who.length > 0 || f.cancelled
  );
}

/** Number of distinct active criteria, for badges. */
export function activeFilterCount(f: Filter): number {
  return [
    f.q.trim() !== '',
    f.types.length > 0,
    !!f.from || !!f.to,
    f.who.length > 0,
    f.cancelled,
  ].filter(Boolean).length;
}

function matchesQuery(e: Event, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [e.name, e.location?.name, e.location?.address, e.confirmation, e.notes].some(
    (s) => s !== undefined && s.toLowerCase().includes(needle),
  );
}

/** Pure; rules per the bead and CONTRACTS.md section 7. */
export function filterEvents(events: readonly Event[], filter: Filter): Event[] {
  const { from, to } = filter;
  return events.filter((e) => {
    if (e.status === 'cancelled' && !filter.cancelled) return false;
    if (!matchesQuery(e, filter.q)) return false;
    if (filter.types.length > 0 && !filter.types.includes(e.type)) return false;
    if (filter.who.length > 0 && e.participants.length > 0) {
      if (!e.participants.some((p) => filter.who.includes(p))) return false;
    }
    if (from || to) {
      if (!e.start) return false;
      // The event's own local calendar dates (string order is date order).
      const startDay = e.start.local.slice(0, 10);
      const endDay = e.end ? e.end.local.slice(0, 10) : startDay;
      const lastDay = endDay < startDay ? startDay : endDay;
      if (from && lastDay < from) return false;
      if (to && startDay > to) return false;
    }
    return true;
  });
}

const LEGACY_TRANSIT = ['flight', 'train', 'bus', 'ferry', 'car'];

const typesCodec = {
  parse: (raw: string) => {
    const list = stringListCodec.parse(raw);
    // Old URLs filter by flight/train/bus/ferry/car; those types were merged into transit.
    const mapped = list?.map((t) => (LEGACY_TRANSIT.includes(t) ? 'transit' : t));
    return mapped
      ?.filter((t): t is EventType => (EVENT_TYPES as readonly string[]).includes(t))
      .filter((t, i, a) => a.indexOf(t) === i);
  },
  serialize: (v: EventType[]) => stringListCodec.serialize(v),
};

export type FilterApi = {
  filter: Filter;
  setFilter: (patch: Partial<Filter>) => void;
  clear: () => void;
};

const NO_TYPES: EventType[] = [];
const NO_WHO: string[] = [];
// Filter edits replace the history entry instead of stacking one per keystroke.
const R = { replace: true };

/** Filter state bound to the URL query (q, type, from, to, who, cancelled), plus setters. */
export function useFilterState(): FilterApi {
  const [q, setQ] = useQueryState('q', stringCodec, '', R);
  const [types, setTypes] = useQueryState('type', typesCodec, NO_TYPES, R);
  const [from, setFrom] = useQueryState('from', dateCodec, '', R);
  const [to, setTo] = useQueryState('to', dateCodec, '', R);
  const [who, setWho] = useQueryState('who', stringListCodec, NO_WHO, R);
  const [cancelled, setCancelled] = useQueryState('cancelled', booleanCodec, false, R);

  // The codecs return fresh arrays each render, so key the memo on their contents.
  const typesKey = types.join(',');
  const whoKey = who.join(',');
  const filter = useMemo<Filter>(() => {
    let f = from || undefined;
    let t = to || undefined;
    if (f && t && f > t) [f, t] = [t, f];
    return { q, types, from: f, to: t, who, cancelled };
  }, [q, typesKey, from, to, whoKey, cancelled]);
  const setFilter = (patch: Partial<Filter>) => {
    if (patch.q !== undefined) setQ(patch.q);
    if (patch.types !== undefined) setTypes(patch.types);
    if ('from' in patch) setFrom(patch.from ?? '');
    if ('to' in patch) setTo(patch.to ?? '');
    if (patch.who !== undefined) setWho(patch.who);
    if (patch.cancelled !== undefined) setCancelled(patch.cancelled);
  };
  const clear = () =>
    setFilter({ q: '', types: [], from: undefined, to: undefined, who: [], cancelled: false });
  return { filter, setFilter, clear };
}

export function useFilter(): Filter {
  return useFilterState().filter;
}

export function useFilteredEvents(): Event[] {
  const events = useTrip((s) => s.events);
  const filter = useFilter();
  return useMemo(() => filterEvents(events, filter), [events, filter]);
}
