import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Event } from '@planfully/shared';
import { FilterButton, SearchField } from './FilterControls';
import {
  filterEvents,
  filterSummary,
  useFilter,
  useFilterState,
  useFilteredEvents,
  type Filter,
} from './filter';

const mk = (id: string, over: Partial<Event> = {}): Event => ({
  id,
  name: id,
  type: 'activity',
  attachments: [],
  participants: [],
  status: 'confirmed',
  source: 'manual',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const at = (local: string, tz = 'Europe/Paris') => ({ local, tz });
const F = (over: Partial<Filter> = {}): Filter => ({
  q: '',
  types: [],
  who: [],
  cancelled: false,
  ...over,
});
const ids = (es: Event[]) => es.map((e) => e.id);

const EVENTS: Event[] = [
  mk('museum', {
    name: 'Louvre',
    location: { name: 'Musée du Louvre', address: 'Rue de Rivoli' },
    start: at('2026-05-02T10:00'),
    end: at('2026-05-02T12:00'),
    notes: 'bring umbrella',
  }),
  mk('hotel', {
    name: 'Hotel Lutetia',
    type: 'lodging',
    confirmation: 'ABC123',
    start: at('2026-05-01T15:00'),
    end: at('2026-05-05T11:00'),
    participants: ['a'],
  }),
  mk('dinner', { type: 'dining', start: at('2026-05-03T19:00'), participants: ['a', 'b'] }),
  mk('later', { start: at('2026-05-10T09:00'), participants: ['b'] }),
  mk('idea'),
  mk('gone', { status: 'cancelled', start: at('2026-05-02T09:00') }),
];

describe('filterEvents', () => {
  test('empty filter keeps all but cancelled', () => {
    expect(ids(filterEvents(EVENTS, F()))).toEqual(['museum', 'hotel', 'dinner', 'later', 'idea']);
  });
  test('cancelled toggle', () => {
    expect(ids(filterEvents(EVENTS, F({ cancelled: true })))).toContain('gone');
  });
  test('q is case-insensitive over name, location, address, confirmation, notes', () => {
    const q = (s: string) => ids(filterEvents(EVENTS, F({ q: s })));
    expect(q('LOUVRE')).toEqual(['museum']);
    expect(q('rivoli')).toEqual(['museum']);
    expect(q('abc1')).toEqual(['hotel']);
    expect(q('umbrella')).toEqual(['museum']);
    expect(q('lutetia')).toEqual(['hotel']);
    expect(q('nothing')).toEqual([]);
  });
  test('types: empty is all, otherwise membership', () => {
    expect(ids(filterEvents(EVENTS, F({ types: ['lodging', 'dining'] })))).toEqual([
      'hotel',
      'dinner',
    ]);
  });
  test('who: everyone events always match; others intersect', () => {
    expect(ids(filterEvents(EVENTS, F({ who: ['b'] })))).toEqual([
      'museum',
      'dinner',
      'later',
      'idea',
    ]);
    expect(ids(filterEvents(EVENTS, F({ who: ['a'] })))).toEqual([
      'museum',
      'hotel',
      'dinner',
      'idea',
    ]);
  });
  test('date range edges are inclusive on local dates', () => {
    const r = (from?: string, to?: string) => ids(filterEvents(EVENTS, F({ from, to })));
    expect(r('2026-05-02', '2026-05-02')).toEqual(['museum', 'hotel']);
    expect(r('2026-05-03', '2026-05-03')).toEqual(['hotel', 'dinner']);
    expect(r('2026-05-10', '2026-05-10')).toEqual(['later']);
    expect(r('2026-05-06', '2026-05-09')).toEqual([]);
  });
  test('multi-day lodging overlaps a range inside, at either end, and spanning it', () => {
    const r = (from?: string, to?: string) =>
      ids(
        filterEvents(
          EVENTS.filter((e) => e.id === 'hotel'),
          F({ from, to }),
        ),
      );
    expect(r('2026-05-03', '2026-05-04')).toEqual(['hotel']); // inside
    expect(r('2026-04-20', '2026-05-01')).toEqual(['hotel']); // touches start day
    expect(r('2026-05-05', '2026-06-01')).toEqual(['hotel']); // touches end day
    expect(r('2026-04-01', '2026-04-30')).toEqual([]);
    expect(r('2026-05-06')).toEqual([]);
  });
  test('open-ended ranges', () => {
    expect(ids(filterEvents(EVENTS, F({ from: '2026-05-04' })))).toEqual(['hotel', 'later']);
    expect(ids(filterEvents(EVENTS, F({ to: '2026-05-01' })))).toEqual(['hotel']);
  });
  test('event without end counts as one day; uses own local date, not instant', () => {
    // 23:30 Paris is still 2026-05-03 locally even though it is earlier than midnight UTC+0 of the 4th
    const e = mk('late', { start: at('2026-05-03T23:30') });
    expect(filterEvents([e], F({ from: '2026-05-03', to: '2026-05-03' }))).toHaveLength(1);
    expect(filterEvents([e], F({ from: '2026-05-04' }))).toHaveLength(0);
  });
  test('unscheduled events pass only without a date filter', () => {
    const idea = [mk('idea')];
    expect(filterEvents(idea, F())).toHaveLength(1);
    expect(filterEvents(idea, F({ from: '2026-05-01' }))).toHaveLength(0);
    expect(filterEvents(idea, F({ to: '2026-05-01' }))).toHaveLength(0);
  });
  test('criteria combine with AND', () => {
    expect(ids(filterEvents(EVENTS, F({ types: ['activity'], from: '2026-05-10' })))).toEqual([
      'later',
    ]);
  });
});

vi.mock('../trip/store', () => ({
  useTrip: (sel?: (s: unknown) => unknown) => {
    const state = {
      events: EVENTS,
      meta: {
        roster: [
          { id: 'a', name: 'Ann', aliases: [] },
          { id: 'b', name: 'Bob', aliases: [] },
        ],
      },
    };
    return sel ? sel(state) : state;
  },
}));

afterEach(cleanup);

function Loc() {
  const l = useLocation();
  return <output data-testid="loc">{l.search + l.hash}</output>;
}
const wrap =
  (initial: string) =>
  ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  );

describe('useFilter', () => {
  test('reads filter from query and ignores invalid values', () => {
    const { result } = renderHook(() => useFilter(), {
      wrapper: wrap(
        '/t/x?q=lou&type=lodging,bogus&from=2026-05-01&to=nope&who=a,b&cancelled=1#sec',
      ),
    });
    expect(result.current).toEqual({
      q: 'lou',
      types: ['lodging'],
      from: '2026-05-01',
      to: undefined,
      who: ['a', 'b'],
      cancelled: true,
      excludeTypes: [],
      excludeWho: [],
    });
  });

  test('reads - prefixed values as excludes, with the legacy transit mapping on both signs', () => {
    const { result } = renderHook(() => useFilter(), {
      wrapper: wrap('/t/x?type=lodging,-dining,-flight,-bogus&who=a,-b'),
    });
    expect(result.current.types).toEqual(['lodging']);
    expect(result.current.excludeTypes).toEqual(['dining', 'transit']);
    expect(result.current.who).toEqual(['a']);
    expect(result.current.excludeWho).toEqual(['b']);
  });

  test('a value in both lists stays include only', () => {
    const { result } = renderHook(() => useFilter(), { wrapper: wrap('/t/x?type=dining,-dining') });
    expect(result.current.types).toEqual(['dining']);
    expect(result.current.excludeTypes).toEqual([]);
  });
});

/** The app bar's filter pieces: filters icon (panel on demand) and the search field. */
function FilterBar({ phone = false, search = true }: { phone?: boolean; search?: boolean }) {
  const api = useFilterState();
  return (
    <>
      <FilterButton api={api} phone={phone} />
      {search && <SearchField api={api} onClose={() => undefined} />}
    </>
  );
}
const openPanel = () => fireEvent.click(screen.getByRole('button', { name: /^Filters/ }));

describe('filterEvents excludes', () => {
  const run = (f: Partial<Filter>) => ids(filterEvents(EVENTS, F(f)));
  test('exclude-only type filter keeps everything else', () => {
    expect(run({ excludeTypes: ['dining'] })).toEqual(['museum', 'hotel', 'later', 'idea']);
  });
  test('include and exclude types combine', () => {
    expect(run({ types: ['lodging', 'dining'], excludeTypes: ['dining'] })).toEqual(['hotel']);
  });
  test('excluded person: only events whose participants are all excluded are dropped', () => {
    // dinner is shared with a; museum and idea are Everyone events
    expect(run({ excludeWho: ['b'] })).toEqual(['museum', 'hotel', 'dinner', 'idea']);
    expect(run({ excludeWho: ['a', 'b'] })).toEqual(['museum', 'idea']);
  });
  test('include who and exclude type mix', () => {
    expect(run({ who: ['b'], excludeTypes: ['dining'] })).toEqual(['museum', 'later', 'idea']);
  });
  test('exclude who with include who', () => {
    expect(run({ who: ['a'], excludeWho: ['a'] })).toEqual(['museum', 'dinner', 'idea']);
  });
});

describe('tri-state chips', () => {
  const Wrapped = () => (
    <>
      <FilterBar search={false} />
      <Loc />
    </>
  );
  test('click cycles none -> include -> exclude -> none, URL follows', () => {
    render(
      <MemoryRouter initialEntries={['/t/x']}>
        <Wrapped />
      </MemoryRouter>,
    );
    openPanel();
    const chip = () => screen.getByRole('button', { name: /^Dining:/ });
    expect(chip().getAttribute('aria-label')).toBe('Dining: not filtered. Activate to include');
    fireEvent.click(chip());
    expect(chip().getAttribute('aria-label')).toBe('Dining: included. Activate to exclude');
    expect(screen.getByTestId('loc').textContent).toBe('?type=dining');
    fireEvent.click(chip());
    expect(chip().getAttribute('aria-label')).toBe('Dining: excluded. Activate to clear');
    expect(screen.getByTestId('loc').textContent).toBe('?type=-dining');
    expect(screen.getByText(/of 6 events/).textContent).toBe('4 of 6 events');
    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeTruthy();
    fireEvent.click(chip());
    expect(screen.getByTestId('loc').textContent).toBe('');
  });

  test('who chips cycle too, and Clear all removes excludes', () => {
    render(
      <MemoryRouter initialEntries={['/t/x?who=-b&type=-dining']}>
        <Wrapped />
      </MemoryRouter>,
    );
    openPanel();
    expect(screen.getByRole('button', { name: 'Filters, 2 active' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Bob: excluded/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByTestId('loc').textContent).toBe('');
  });
});

describe('filter controls', () => {
  test('count changes as filters change and survives via URL; clear-all resets; hash kept', () => {
    render(
      <MemoryRouter initialEntries={['/t/x#sec']}>
        <FilterBar />
        <Loc />
      </MemoryRouter>,
    );
    expect(screen.queryByText(/of 6 events/)).toBeNull();
    openPanel();
    expect(screen.getByText(/of 6 events/).textContent).toBe('5 of 6 events');
    fireEvent.click(screen.getByRole('button', { name: /^Lodging:/ }));
    expect(screen.getByText(/of 6 events/).textContent).toBe('1 of 6 events');
    fireEvent.change(screen.getByLabelText('Search events'), { target: { value: 'zzz' } });
    expect(screen.getByText(/of 6 events/).textContent).toBe('0 of 6 events');
    const loc = screen.getByTestId('loc').textContent ?? '';
    expect(loc).toContain('type=lodging');
    expect(loc).toContain('q=zzz');
    expect(loc.endsWith('#sec')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(screen.getByTestId('loc').textContent).toBe('#sec');
    expect(screen.getByText(/of 6 events/).textContent).toBe('5 of 6 events');
  });

  test('participant chips come from the roster; show cancelled', () => {
    render(
      <MemoryRouter initialEntries={['/t/x']}>
        <FilterBar search={false} />
      </MemoryRouter>,
    );
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Ann:/ }));
    expect(screen.getByText(/of 6 events/).textContent).toBe('4 of 6 events');
    fireEvent.click(screen.getByLabelText('Show cancelled'));
    expect(screen.getByText(/of 6 events/).textContent).toBe('5 of 6 events');
  });

  test('initial URL state is applied (reload) and counted on the button', () => {
    render(
      <MemoryRouter initialEntries={['/t/x?type=dining']}>
        <FilterBar search={false} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Filters, 1 active' })).toBeTruthy();
    openPanel();
    expect(screen.getByText(/of 6 events/).textContent).toBe('1 of 6 events');
    expect(
      screen.getByRole('button', { name: 'Dining: included. Activate to exclude' }),
    ).toBeTruthy();
  });

  test('phone: the filters icon opens a bottom sheet with Done', () => {
    render(
      <MemoryRouter initialEntries={['/t/x?type=dining']}>
        <FilterBar phone search={false} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Filters, 1 active' }));
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show 1 event' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('filterSummary', () => {
  const roster = [{ id: 'a', name: 'Alex' }];
  test('empty when nothing is filtered', () => {
    expect(filterSummary(F(), roster)).toBe('');
  });
  test('lists types, people, dates, search and cancelled', () => {
    expect(filterSummary(F({ types: ['dining'], who: ['a'] }), roster)).toBe('Dining, Alex');
    expect(
      filterSummary(F({ q: ' bar ', from: '2026-05-02', to: '2026-05-09', cancelled: true }), []),
    ).toBe('"bar", 2026-05-02 to 2026-05-09, Cancelled');
    expect(filterSummary(F({ from: '2026-05-02', who: ['zz'] }), roster)).toBe(
      'zz, from 2026-05-02',
    );
    expect(
      filterSummary(F({ types: ['lodging'], excludeTypes: ['dining'], excludeWho: ['a'] }), roster),
    ).toBe('Lodging, not Dining, not Alex');
  });
});

describe('identity and history', () => {
  test('filter and filtered events are referentially stable across rerenders', () => {
    const { result, rerender } = renderHook(() => ({ f: useFilter(), e: useFilteredEvents() }), {
      wrapper: wrap('/t/x?type=dining,lodging&who=a'),
    });
    const first = result.current;
    rerender();
    expect(result.current.f).toBe(first.f);
    expect(result.current.e).toBe(first.e);
  });

  test('legacy ?type=flight,train URLs map to the transit chip', () => {
    const { result } = renderHook(() => useFilter(), {
      wrapper: wrap('/t/x?type=flight,train,dining,car'),
    });
    expect(result.current.types).toEqual(['transit', 'dining']);
  });

  test('from after to is swapped', () => {
    const { result } = renderHook(() => useFilter(), {
      wrapper: wrap('/t/x?from=2026-05-09&to=2026-05-02'),
    });
    expect(result.current.from).toBe('2026-05-02');
    expect(result.current.to).toBe('2026-05-09');
  });

  test('typing replaces history entries', () => {
    let nav: ReturnType<typeof useNavigationType> | undefined;
    function Nav() {
      nav = useNavigationType();
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/t/x']}>
        <FilterBar />
        <Nav />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search events'), { target: { value: 'a' } });
    expect(nav).toBe('REPLACE');
  });
});
