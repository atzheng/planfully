/** Temp (optimistic) records have seqs above this; skip them for compaction or offline caches. */
export const TEMP_SEQ_BASE = Number.MAX_SAFE_INTEGER - 1_000_000;
export function isTempSeq(seq: number): boolean {
  return seq > TEMP_SEQ_BASE;
}
