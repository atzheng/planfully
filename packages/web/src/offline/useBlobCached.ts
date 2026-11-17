import { useEffect, useState } from 'react';
import { getOfflineDb } from './db';

/** Whether an attachment's sealed bytes are in the offline cache. Re-checks when `recheck` changes. */
export function useBlobCached(blobId: string, recheck?: unknown): boolean {
  const [cached, setCached] = useState(false);
  useEffect(() => {
    let live = true;
    const db = getOfflineDb();
    if (!db) return;
    db.hasBlob(blobId).then(
      (v) => live && setCached(v),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [blobId, recheck]);
  return cached;
}
