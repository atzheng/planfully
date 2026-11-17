import { useParams } from 'react-router';
import { EventSheet } from './event/EventSheet';
import { FilterBar } from './filters/FilterBar';
import { enumCodec, useQueryState } from './lib/queryState';
import { MapView } from './map/MapView';
import { Timeline } from './timeline/Timeline';
import { useTrip } from './trip/store';
import { Chip } from './ui/Chip';
import styles from './TripShell.module.css';

const VIEWS = ['timeline', 'map'] as const;
const viewCodec = enumCodec(VIEWS);

export function TripShell() {
  const { tripId } = useParams();
  const name = useTrip((s) => s.meta?.name);
  const status = useTrip((s) => s.status);
  const error = useTrip((s) => s.error);
  const skipped = useTrip((s) => s.skipped);
  const [view, setView] = useQueryState('view', viewCodec, 'timeline');

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.title} data-slot="trip-name">
          {name ?? `Trip ${tripId}`}
        </h1>
        <div className={styles.actions} data-slot="actions" />
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
            {error && <p role="status">{error.message}</p>}
            {skipped > 0 && (
              <p role="status">
                {skipped} {skipped === 1 ? 'item' : 'items'} couldn&apos;t be read
              </p>
            )}
            {view === 'map' ? <MapView /> : <Timeline />}
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
  );
}
