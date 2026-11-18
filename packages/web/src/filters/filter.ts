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
  /** Event types to hide. Disjoint from `types`. */
  excludeTypes?: EventType[];
  /** 'YYYY-MM-DD', inclusive */
  from?: string;
  /** 'YYYY-MM-DD', inclusive */
  to?: string;
  who: string[];
  /** Participants to hide; see filterEvents for the rule. Disjoint from `who`. */
  excludeWho?: string[];
  cancelled: boolean;
};

export type ChipState = 'none' | 'include' | 'exclude';
export const NEXT_CHIP_STATE: Record<ChipState, ChipState> = {
  none: 'include',
  include: 'exclude',
  exclude: 'none',
};

/** Where `v` sits in a filter's include / exclude pair. */
export function chipState<T>(
  include: readonly T[],
  exclude: readonly T[] | undefined,
  v: T,
): ChipState {
  if (include.includes(v)) return 'include';
  if (exclude?.includes(v)) return 'exclude';
  return 'none';
}

/** The include / exclude lists after moving `v` to `state`. */
export function withChipState<T>(
  include: readonly T[],
  exclude: readonly T[] | undefined,
  v: T,
  state: ChipState,
): { include: T[]; exclude: T[] } {
  const inc = include.filter((x) => x !== v);
  const exc = (exclude ?? []).filter((x) => x !== v);
  if (state === 'include') inc.push(v);
  if (state === 'exclude') exc.push(v);
  return { include: inc, exclude: exc };
}

/** URL form: excluded values carry a leading '-'. Pure. */
export function splitSigned(list: readonly string[]): { include: string[]; exclude: string[] } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const raw of list) {
    if (raw.startsWith('-')) {
      if (raw.length > 1) exclude.push(raw.slice(1));
    } else if (raw !== '') include.push(raw);
  }
  // A value in both lists: the include wins, so the two stay disjoint.
  return { include, exclude: exclude.filter((x) => !include.includes(x)) };
}

export function joinSigned(
  include: readonly string[],
  exclude: readonly string[] | undefined,
): string[] {
  return [...include, ...(exclude ?? []).map((x) => `-${x}`)];
}

export function isFilterActive(f: Filter): boolean {
  return (
    f.q.trim() !== '' ||
    f.types.length > 0 ||
    !!f.excludeTypes?.length ||
    !!f.from ||
    !!f.to ||
    f.who.length > 0 ||
    !!f.excludeWho?.length ||
    f.cancelled
  );
}

/** Number of distinct active criteria, for badges. */
export function activeFilterCount(f: Filter): number {
  return [
    f.q.trim() !== '',
    f.types.length > 0 || !!f.excludeTypes?.length,
    !!f.from || !!f.to,
    f.who.length > 0 || !!f.excludeWho?.length,
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

/**
 * Pure; rules per the bead and CONTRACTS.md section 7.
 * Type: a non-empty include list must contain the type; an excluded type is dropped.
 * Who: an include list keeps events with no participants (Everyone) or one listed participant.
 * An exclude list drops only events with explicit participants who are ALL excluded; an event
 * shared with someone not excluded, and Everyone events, stay.
 */
export function filterEvents(events: readonly Event[], filter: Filter): Event[] {
  const { from, to } = filter;
  return events.filter((e) => {
    if (e.status === 'cancelled' && !filter.cancelled) return false;
    if (!matchesQuery(e, filter.q)) return false;
    if (filter.types.length > 0 && !filter.types.includes(e.type)) return false;
    if (filter.excludeTypes?.includes(e.type)) return false;
    const exWho = filter.excludeWho;
    if (
      exWho?.length &&
      e.participants.length > 0 &&
      e.participants.every((p) => exWho.includes(p))
    )
      return false;
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

/** `type` URL value: includes plain, excludes with a leading '-' (e.g. `lodging,-dining`). */
type TypeSel = { include: EventType[]; exclude: EventType[] };
type WhoSel = { include: string[]; exclude: string[] };
const validType = (t: string): t is EventType => (EVENT_TYPES as readonly string[]).includes(t);
const uniq = <T>(l: T[]) => l.filter((t, i, a) => a.indexOf(t) === i);
const typesCodec = {
  parse: (raw: string): TypeSel | undefined => {
    const list = stringListCodec.parse(raw);
    if (!list) return undefined;
    const { include, exclude } = splitSigned(list);
    // Old URLs filter by flight/train/bus/ferry/car; those types were merged into transit.
    const map = (l: string[]) =>
      uniq(l.map((t) => (LEGACY_TRANSIT.includes(t) ? 'transit' : t)).filter(validType));
    const inc = map(include);
    return { include: inc, exclude: map(exclude).filter((t) => !inc.includes(t)) };
  },
  serialize: (v: TypeSel) => stringListCodec.serialize(joinSigned(v.include, v.exclude)),
};
const whoCodec = {
  parse: (raw: string): WhoSel | undefined => {
    const list = stringListCodec.parse(raw);
    return list ? splitSigned(list) : undefined;
  },
  serialize: (v: WhoSel) => stringListCodec.serialize(joinSigned(v.include, v.exclude)),
};

export type FilterApi = {
  filter: Filter;
  setFilter: (patch: Partial<Filter>) => void;
  clear: () => void;
};

const NO_TYPES: TypeSel = { include: [], exclude: [] };
const NO_WHO: WhoSel = { include: [], exclude: [] };
// Filter edits replace the history entry instead of stacking one per keystroke.
const R = { replace: true };

/** Filter state bound to the URL query (q, type, from, to, who, cancelled), plus setters. */
export function useFilterState(): FilterApi {
  const [q, setQ] = useQueryState('q', stringCodec, '', R);
  const [typeSel, setTypes] = useQueryState('type', typesCodec, NO_TYPES, R);
  const [from, setFrom] = useQueryState('from', dateCodec, '', R);
  const [to, setTo] = useQueryState('to', dateCodec, '', R);
  const [whoSel, setWho] = useQueryState('who', whoCodec, NO_WHO, R);
  const [cancelled, setCancelled] = useQueryState('cancelled', booleanCodec, false, R);

  // The codecs return fresh arrays each render, so key the memo on their contents.
  const typesKey = joinSigned(typeSel.include, typeSel.exclude).join(',');
  const whoKey = joinSigned(whoSel.include, whoSel.exclude).join(',');
  const filter = useMemo<Filter>(() => {
    let f = from || undefined;
    let t = to || undefined;
    if (f && t && f > t) [f, t] = [t, f];
    return {
      q,
      types: typeSel.include,
      excludeTypes: typeSel.exclude,
      from: f,
      to: t,
      who: whoSel.include,
      excludeWho: whoSel.exclude,
      cancelled,
    };
  }, [q, typesKey, from, to, whoKey, cancelled]);
  const setFilter = (patch: Partial<Filter>) => {
    if (patch.q !== undefined) setQ(patch.q);
    if (patch.types !== undefined || patch.excludeTypes !== undefined)
      setTypes({
        include: patch.types ?? typeSel.include,
        exclude: patch.excludeTypes ?? typeSel.exclude,
      });
    if ('from' in patch) setFrom(patch.from ?? '');
    if ('to' in patch) setTo(patch.to ?? '');
    if (patch.who !== undefined || patch.excludeWho !== undefined)
      setWho({
        include: patch.who ?? whoSel.include,
        exclude: patch.excludeWho ?? whoSel.exclude,
      });
    if (patch.cancelled !== undefined) setCancelled(patch.cancelled);
  };
  const clear = () =>
    setFilter({
      q: '',
      types: [],
      excludeTypes: [],
      from: undefined,
      to: undefined,
      who: [],
      excludeWho: [],
      cancelled: false,
    });
  return { filter, setFilter, clear };
}

export function useFilter(): Filter {
  return useFilterState().filter;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One-line summary of the active criteria for the app bar chip, e.g. 'Dining, Alex' or 'Lodging, not Dining'.
 * Empty when nothing is filtered. Pure.
 */
export function filterSummary(f: Filter, roster: readonly { id: string; name: string }[]): string {
  const parts: string[] = [];
  if (f.q.trim() !== '') parts.push(`"${f.q.trim()}"`);
  const name = (id: string) => roster.find((m) => m.id === id)?.name ?? id;
  parts.push(...f.types.map(cap));
  parts.push(...f.who.map(name));
  parts.push(...(f.excludeTypes ?? []).map((t) => `not ${cap(t)}`));
  parts.push(...(f.excludeWho ?? []).map((id) => `not ${name(id)}`));
  if (f.from && f.to) parts.push(`${f.from} to ${f.to}`);
  else if (f.from) parts.push(`from ${f.from}`);
  else if (f.to) parts.push(`to ${f.to}`);
  if (f.cancelled) parts.push('Cancelled');
  return parts.join(', ');
}

export function useFilteredEvents(): Event[] {
  const events = useTrip((s) => s.events);
  const filter = useFilter();
  return useMemo(() => filterEvents(events, filter), [events, filter]);
}

/** The `who` URL value as include / exclude lists, for components that read it directly. */
export function useWhoSelection(): { include: string[]; exclude: string[] } {
  const { filter } = useFilterState();
  return { include: filter.who, exclude: filter.excludeWho ?? [] };
}
