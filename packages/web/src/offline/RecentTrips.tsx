import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../ui/Button';
import { getOfflineDb, safely, type CachedTrip } from './db';
import styles from './RecentTrips.module.css';

export function formatOpened(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(t).toLocaleDateString();
}

/** Trips cached on this device, linking back in with the stored secret. */
export function RecentTrips() {
  const [trips, setTrips] = useState<CachedTrip[]>([]);

  const refresh = useCallback(async () => {
    const db = getOfflineDb();
    if (!db) return;
    const list = await safely(() => db.listTrips());
    setTrips(list ?? []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const forget = async (tripId: string) => {
    const db = getOfflineDb();
    if (db) await safely(() => db.forgetTrip(tripId));
    await refresh();
  };

  if (trips.length === 0) return null;
  return (
    <section aria-labelledby="recent-trips" className={styles.section}>
      <h2 id="recent-trips" className={styles.heading}>
        Trips on this device
      </h2>
      <ul className={styles.list}>
        {trips.map((t) => (
          <li key={t.tripId} className={styles.item}>
            <Link to={`/t/${encodeURIComponent(t.tripId)}#${t.secret}`} className={styles.link}>
              <span className={styles.name}>{t.meta.name}</span>
              <span className={styles.when}>
                {t.revokedAt ? 'Link no longer works' : `Opened ${formatOpened(t.openedAt)}`}
              </span>
            </Link>
            <Button
              onClick={() => void forget(t.tripId)}
              aria-label={`Forget ${t.meta.name} on this device`}
            >
              Forget on this device
            </Button>
          </li>
        ))}
      </ul>
      <p className={styles.note}>
        Each trip&apos;s key is stored on this device in plain form so the app can reopen it without
        the link. Anyone who can use this browser profile can open these trips. Forgetting a trip
        removes its key, saved events and saved files from this device only.
      </p>
    </section>
  );
}
