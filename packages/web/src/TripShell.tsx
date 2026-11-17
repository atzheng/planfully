import { useParams } from 'react-router';
import { EventSheet } from './event/EventSheet';
import { FilterBar } from './filters/FilterBar';
import { enumCodec, useQueryState } from './lib/queryState';
import { MapView } from './map/MapView';
import { Timeline } from './timeline/Timeline';
import { Chip } from './ui/Chip';
import styles from './TripShell.module.css';

const VIEWS = ['timeline', 'map'] as const;
const viewCodec = enumCodec(VIEWS);

export function TripShell() {
  const { tripId } = useParams();
  const [view, setView] = useQueryState('view', viewCodec, 'timeline');

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.title} data-slot="trip-name">
          Trip {tripId}
        </h1>
        <div className={styles.actions} data-slot="actions" />
      </header>
      <div className={styles.filters} data-slot="filters">
        <FilterBar />
      </div>
      <main className={styles.main}>{view === 'map' ? <MapView /> : <Timeline />}</main>
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
