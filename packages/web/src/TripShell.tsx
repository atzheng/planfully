import { lazy, Suspense } from 'react';
import { AddEventButton, AddEventProvider } from './event/AddEvent';
import { AppBar, type View } from './chrome/AppBar';
import { EventSheet } from './event/EventSheet';
import { enumCodec, stringCodec, useQueryState } from './lib/queryState';
import { TimelineControlsProvider } from './timeline/controls';
import { Timeline } from './timeline/Timeline';
import { useTrip, useTripStore } from './trip/store';
import styles from './TripShell.module.css';

// Maps code is only fetched when the map view opens.
const MapView = lazy(() => import('./map/MapView').then((m) => ({ default: m.MapView })));

const VIEWS: readonly View[] = ['timeline', 'map'];
const viewCodec = enumCodec(VIEWS);

export function TripShell() {
  const status = useTrip((s) => s.status);
  const error = useTrip((s) => s.error);
  const skipped = useTrip((s) => s.skipped);
  const lastError = useTrip((s) => s.lastError);
  const store = useTripStore();
  const [openEvent] = useQueryState('e', stringCodec, '');
  const [view, setView] = useQueryState('view', viewCodec, 'timeline');

  const notices = (lastError && !openEvent) || error || skipped > 0;

  return (
    <AddEventProvider>
      <TimelineControlsProvider>
        <div className={styles.shell}>
          <AppBar view={view} setView={setView} />
          <main className={styles.main}>
            {status === 'error' ? (
              <p role="alert">{error?.message}</p>
            ) : status === 'loading' ? (
              <p role="status">Loading trip...</p>
            ) : (
              <>
                {notices && (
                  <div className={styles.notices}>
                    {/* With the event sheet open it shows the same error itself. */}
                    {lastError && !openEvent && (
                      <p role="alert" className={styles.error} data-testid="write-error">
                        Could not save: {lastError.message}{' '}
                        <button
                          type="button"
                          className={styles.linkButton}
                          onClick={() => store.getState().setWriteState({ lastError: null })}
                        >
                          Dismiss
                        </button>
                      </p>
                    )}
                    {error && <p role="status">{error.message}</p>}
                    {skipped > 0 && (
                      <p role="status">
                        {skipped} {skipped === 1 ? 'item' : 'items'} couldn&apos;t be read
                      </p>
                    )}
                  </div>
                )}
                {view === 'map' ? (
                  <div className={styles.mapHost}>
                    <Suspense fallback={<p role="status">Loading map...</p>}>
                      <MapView />
                    </Suspense>
                  </div>
                ) : (
                  <Timeline />
                )}
              </>
            )}
          </main>
          <AddEventButton />
          <EventSheet />
        </div>
      </TimelineControlsProvider>
    </AddEventProvider>
  );
}
