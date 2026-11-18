import { useState } from 'react';
import { useFilter, useFilteredEvents } from '../filters/filter';
import { useTrip } from '../trip/store';
import { downloadIcs } from './ics';
import { buildItinerary, renderPdf } from './pdf';

export type ExportItem = { id: string; label: string; run: () => Promise<void> };

/**
 * Export actions for the overflow menu. To add a format, append an entry to `items`.
 * `choose` runs one and reports progress (`busy`) and failure (`error`).
 */
export function useExport(): {
  items: ExportItem[];
  busy: boolean;
  error: string | null;
  choose: (item: ExportItem) => Promise<void>;
  dismiss: () => void;
} {
  const events = useFilteredEvents();
  const filter = useFilter();
  const meta = useTrip((s) => s.meta);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items: ExportItem[] = [
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

  const choose = async (item: ExportItem) => {
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

  return { items, busy, error, choose, dismiss: () => setError(null) };
}
