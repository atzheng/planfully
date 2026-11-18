// Adding events by hand (planfully-ecw.3): an Add button, an empty form in a sheet, and an entry
// point for the map to start an event at a point. The sheet lives in one place (AddEventProvider)
// so the shell button and the map share it.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { fromInstant, type Event } from '@planfully/shared';
import { useTripActions } from '../trip/actions';
import { useTrip, useTripStore } from '../trip/store';
import { Button } from '../ui/Button';
import { Sheet } from '../ui/Sheet';
import { EventForm } from './EventForm';
import { SheetHeader } from './SheetHeader';
import styles from './AddEvent.module.css';

/** The time at the centre of what the timeline shows, and the zone it is shown in. */
export type CentreTime = { ms: number; tz: string };

type AddEventApi = {
  /** Open the empty form; `initial` pre-fills it. */
  open(initial?: Partial<Event>): void;
  /** Open the form for a new landmark at a map point. */
  openAtPoint(lat: number, lng: number): void;
  /** The timeline registers how to read its viewport centre while it is mounted. */
  setCentre(get: (() => CentreTime | null) | null): void;
};

const Ctx = createContext<AddEventApi | null>(null);

/** Null outside a provider (views rendered alone in tests). */
export function useAddEvent(): AddEventApi | null {
  return useContext(Ctx);
}

/** Round down so the default start reads as a time someone would pick. */
const ROUND_MS = 15 * 60_000;

export function defaultStart(centre: CentreTime | null): Event['start'] | undefined {
  if (!centre || !Number.isFinite(centre.ms)) return undefined;
  try {
    return fromInstant(Math.floor(centre.ms / ROUND_MS) * ROUND_MS, centre.tz);
  } catch {
    return undefined;
  }
}

/** A map point is a landmark: an attraction with only a location. */
export function pointDraft(lat: number, lng: number): Partial<Event> {
  return { type: 'attraction', location: { lat, lng } };
}

export function AddEventProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<{ key: number; initial: Partial<Event> } | null>(null);
  const centre = useRef<(() => CentreTime | null) | null>(null);
  const counter = useRef(0);
  const lastOpen = useRef(0);

  const open = useCallback((initial?: Partial<Event>) => {
    // A touch long-press can raise both our timer and a contextmenu event: open once.
    const now = Date.now();
    if (now - lastOpen.current < 700) return;
    lastOpen.current = now;
    const start = initial ? undefined : defaultStart(centre.current?.() ?? null);
    setDraft({ key: ++counter.current, initial: initial ?? (start ? { start } : {}) });
  }, []);

  const api = useMemo<AddEventApi>(
    () => ({
      open,
      openAtPoint: (lat, lng) => open(pointDraft(lat, lng)),
      setCentre: (get) => {
        centre.current = get;
      },
    }),
    [open],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {draft && <AddSheet key={draft.key} initial={draft.initial} onClose={() => setDraft(null)} />}
    </Ctx.Provider>
  );
}

function AddSheet({ initial, onClose }: { initial: Partial<Event>; onClose: () => void }) {
  const actions = useTripActions();
  const store = useTripStore();
  const lastError = useTrip((s) => s.lastError);
  return (
    <Sheet open onClose={onClose} label="Add event" side>
      <SheetHeader title="Add event" onClose={onClose} />
      {lastError && (
        <div role="alert" className={styles.error}>
          Could not save: {lastError.message}{' '}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => store.getState().setWriteState({ lastError: null })}
          >
            Dismiss
          </button>
        </div>
      )}
      <EventForm
        initial={initial}
        submitLabel="Add"
        onCancel={onClose}
        onSubmit={async (fields) => {
          // A new event has nothing to clear: drop nulls (e.g. a start blanked from the default).
          const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
          await actions.putEvent(given as Parameters<typeof actions.putEvent>[0]);
          onClose();
        }}
      />
    </Sheet>
  );
}

export function AddEventButton() {
  const add = useAddEvent();
  const status = useTrip((s) => s.status);
  if (!add || status !== 'ready') return null;
  return (
    <Button primary onClick={() => add.open()} aria-label="Add event">
      Add
    </Button>
  );
}

/** Timeline hook-in: keep `get` registered while mounted. */
export function useRegisterCentre(get: () => CentreTime | null): void {
  const add = useAddEvent();
  const ref = useRef(get);
  ref.current = get;
  useEffect(() => {
    if (!add) return;
    add.setCentre(() => ref.current());
    return () => add.setCentre(null);
  }, [add]);
}
