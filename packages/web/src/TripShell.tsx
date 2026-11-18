import { lazy, Suspense } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { AddEventButton, AddEventProvider } from './event/AddEvent';
import { AddReceiptButton } from './event/UploadButtons';
import { ExportMenu } from './export/ExportMenu';
import { EventSheet } from './event/EventSheet';
import { FilterBar } from './filters/FilterBar';
import { getTripQueue } from './offline/queue';
import { enumCodec, stringCodec, useQueryState } from './lib/queryState';
import { Timeline } from './timeline/Timeline';
import { useTrip, useTripStore } from './trip/store';
import { Chip } from './ui/Chip';
import styles from './TripShell.module.css';

// Maps code is only fetched when the map view opens.
const MapView = lazy(() => import('./map/MapView').then((m) => ({ default: m.MapView })));

const VIEWS = ['timeline', 'map'] as const;
const viewCodec = enumCodec(VIEWS);

export function TripShell() {
  const { tripId } = useParams();
  const { hash } = useLocation();
  const name = useTrip((s) => s.meta?.name);
  const status = useTrip((s) => s.status);
  const error = useTrip((s) => s.error);
  const skipped = useTrip((s) => s.skipped);
  const waiting = useTrip((s) => (s.queueStalled ? s.pending : 0));
  const accessLost = useTrip((s) => s.queueAccessLost);
  const lastError = useTrip((s) => s.lastError);
  const store = useTripStore();
  const [openEvent] = useQueryState('e', stringCodec, '');
  const [view, setView] = useQueryState('view', viewCodec, 'timeline');

  return (
    <AddEventProvider>
      <div className={styles.shell}>
        <header className={styles.header}>
          <h1 className={styles.title} data-slot="trip-name">
            {name ?? `Trip ${tripId}`}
          </h1>
          <div className={styles.actions} data-slot="actions">
            <AddEventButton />
            {status === 'ready' && <AddReceiptButton />}
            <ExportMenu />
            <Link
              to={{ pathname: `/t/${encodeURIComponent(tripId ?? '')}/settings`, hash }}
              className={styles.settingsLink}
            >
              Settings
            </Link>
          </div>
        </header>
        <div className={styles.filters} data-slot="filters">
          <FilterBar />
        </div>
        <main className={styles.main}>
          {status === 'error' ? (
            <p role="alert">{error?.message}</p>
          ) : status === 'loading' ? (
            <p role="status">Loading trip...</p>
          ) : (
            <>
              {waiting > 0 && (
                <p role="status" className={styles.waiting} data-testid="sync-waiting">
                  {accessLost
                    ? `Link no longer has access: ${waiting} ${waiting === 1 ? 'change' : 'changes'} not sent`
                    : `${waiting} ${waiting === 1 ? 'change' : 'changes'} waiting to sync`}
                  {accessLost && (
                    <>
                      {' '}
                      <button
                        type="button"
                        className={styles.linkButton}
                        onClick={() => {
                          if (window.confirm('Discard the changes that could not be sent?')) {
                            void getTripQueue(store).discard();
                          }
                        }}
                      >
                        Discard
                      </button>
                    </>
                  )}
                </p>
              )}
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
              {view === 'map' ? (
                <Suspense fallback={<p role="status">Loading map...</p>}>
                  <MapView />
                </Suspense>
              ) : (
                <Timeline />
              )}
            </>
          )}
        </main>
        <nav className={styles.switch} aria-label="View">
          {VIEWS.map((v) => (
            <Chip key={v} selected={view === v} onClick={() => setView(v)}>
              {v === 'timeline' ? 'Timeline' : 'Map'}
            </Chip>
          ))}
        </nav>
        <EventSheet />
      </div>
    </AddEventProvider>
  );
}
