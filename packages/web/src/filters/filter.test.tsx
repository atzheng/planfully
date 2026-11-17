import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Event } from '@planfully/shared';
import { FilterBar } from './FilterBar';
import { filterEvents, useFilter, useFilteredEvents, type Filter } from './filter';

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
    });
  });
});

describe('FilterBar', () => {
  test('count changes as filters change and survives via URL; clear-all resets; hash kept', () => {
    render(
      <MemoryRouter initialEntries={['/t/x#sec']}>
        <FilterBar />
        <Loc />
      </MemoryRouter>,
    );
    expect(screen.getByText(/of 6 events/).textContent).toBe('5 of 6 events');
    fireEvent.click(screen.getByRole('button', { name: 'Lodging' }));
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
        <FilterBar />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ann' }));
    expect(screen.getByText(/of 6 events/).textContent).toBe('4 of 6 events');
    fireEvent.click(screen.getByLabelText('Show cancelled'));
    expect(screen.getByText(/of 6 events/).textContent).toBe('5 of 6 events');
  });

  test('initial URL state is applied (reload)', () => {
    render(
      <MemoryRouter initialEntries={['/t/x?type=dining']}>
        <FilterBar />
      </MemoryRouter>,
    );
    expect(screen.getByText(/of 6 events/).textContent).toBe('1 of 6 events');
    expect(screen.getByRole('button', { name: 'Dining' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  test('phone: collapses to a button opening a sheet', () => {
    const mq = {
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    vi.stubGlobal('matchMedia', () => mq);
    window.matchMedia = (() => mq) as unknown as typeof window.matchMedia;
    render(
      <MemoryRouter initialEntries={['/t/x?type=dining']}>
        <FilterBar />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText('Search events')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Filters (1)' }));
    expect(screen.getByRole('dialog', { name: 'Filters' })).toBeTruthy();
    expect(screen.getByLabelText('Search events')).toBeTruthy();
    vi.unstubAllGlobals();
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
