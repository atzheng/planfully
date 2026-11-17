import { useEffect, useRef, useState } from 'react';
import { useFilter, useFilteredEvents } from '../filters/filter';
import { useTrip } from '../trip/store';
import { Button } from '../ui/Button';
import { downloadIcs } from './ics';
import { buildItinerary, renderPdf } from './pdf';
import styles from './ExportMenu.module.css';

type Item = { id: string; label: string; run: () => Promise<void> };

/** Export button with a dropdown. To add a format (e.g. .ics), append an entry to `items`. */
export function ExportMenu() {
  const events = useFilteredEvents();
  const filter = useFilter();
  const meta = useTrip((s) => s.meta);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const items: Item[] = [
    {
      id: 'pdf',
      label: 'PDF',
      run: () =>
        renderPdf(
          buildItinerary(events, meta?.roster ?? [], filter, { tripName: meta?.name ?? 'Trip' }),
        ),
    },
    {
      id: 'ics',
      label: 'Calendar (.ics)',
      run: async () => downloadIcs(events, meta?.name ?? 'Trip', meta?.roster ?? []),
    },
  ];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = async (item: Item) => {
    setOpen(false);
    setBusy(true);
    setError(null);
    try {
      await item.run();
    } catch {
      setError(`Couldn't create the ${item.label}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.root} ref={root}>
      <Button aria-expanded={open} disabled={busy} onClick={() => setOpen((o) => !o)}>
        {busy ? 'Exporting...' : 'Export'}
      </Button>
      {open && (
        <div className={styles.menu}>
          {items.map((i) => (
            <button key={i.id} type="button" className={styles.item} onClick={() => choose(i)}>
              {i.label}
            </button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
