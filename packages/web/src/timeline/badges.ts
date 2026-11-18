// Participant initial badges on timeline blocks (planfully-u5w). Pure logic; Timeline.tsx renders.
import type { RosterMember } from '@planfully/shared';
import { initials } from '../event/labels';
import { isIconOnly, type BlockTier, type LaneMode } from './layout';

/** Most badges shown before the "+N" one. */
export const MAX_BADGES = 3;
/** Number of colours in the `--person-N-*` palette (theme.css). */
export const PALETTE_SIZE = 8;
/** Badge diameter and the gap between badges, in px (matches `.badgeRow` in Timeline.module.css). */
export const BADGE_PX = 16;
export const BADGE_GAP_PX = 2;
/** Horizontal chrome of a text block: border, padding, type icon and its gap. */
export const BLOCK_CHROME_PX = 40;
/** Estimated average width of one title character (13px semibold). */
export const TITLE_CHAR_PX = 7;
/** Row heights used to check that a badge row fits under the text. */
const TITLE_LINE_PX = 19;
const TEXT_ROW_PX = 18;
const BLOCK_PAD_PX = 8;
const BADGE_ROW_PX = BADGE_PX + 2;

export type Badge = { label: string; tone: number | 'neutral'; name: string | null };

/**
 * Badges for an event's participants, in event order. Roster members get a stable palette tone by roster
 * position; ids that are not in the roster show their raw initials in neutral grey. No participants
 * (an "Everyone" event) gives none.
 */
export function participantBadges(
  ids: readonly string[],
  roster: readonly RosterMember[],
): Badge[] {
  const out: Badge[] = [];
  for (const id of new Set(ids)) {
    const idx = roster.findIndex((r) => r.id === id);
    const m = roster[idx];
    if (m) out.push({ label: initials(m.name), tone: (idx % PALETTE_SIZE) + 1, name: m.name });
    else out.push({ label: initials(id), tone: 'neutral', name: null });
  }
  return out;
}

export type BadgePlacement =
  | { where: 'hidden'; shown: 0; more: 0 }
  | { where: 'inline' | 'below'; shown: number; more: number };

const HIDDEN: BadgePlacement = { where: 'hidden', shown: 0, more: 0 };

/** Pixel width of `shown` badges plus a "+N" one when `more > 0` (about 22px wide). */
function rowWidth(shown: number, more: number): number {
  const items = shown + (more > 0 ? 1 : 0);
  return items * BADGE_PX + Math.max(0, items - 1) * BADGE_GAP_PX + (more > 0 ? 6 : 0);
}

/**
 * Where a block's participant badges go.
 * - `inline`: after the title on its first line, when the whole title and every badge fit on one line.
 * - `below`: own row under the text (full tier only), as many as fit in the width (the rest become
 *   "+N"), when the block is tall enough for the extra row without changing its height.
 * - `hidden`: participant lanes, no participants, bars, icon-only blocks, line blocks without room.
 * At most MAX_BADGES are shown before "+N".
 *
 * `widthPx` is the block's rendered width (blockGeometry x1 - x0, already net of rails and cascade),
 * `heightPx` its height, `textRows` the number of secondary text rows shown under the title (time, place),
 * `reservedPx` extra width taken at the title row's end (e.g. the "needs review" mark).
 */
export function badgePlacement(args: {
  tier: BlockTier;
  widthPx: number;
  heightPx: number;
  titleChars: number;
  count: number;
  laneMode: LaneMode;
  textRows?: number;
  reservedPx?: number;
}): BadgePlacement {
  const { tier, widthPx, heightPx, titleChars, count, laneMode } = args;
  if (count <= 0 || laneMode === 'participant' || tier === 'bar' || isIconOnly(widthPx)) {
    return HIDDEN;
  }
  const shown = Math.min(count, MAX_BADGES);
  const more = count - shown;
  const avail = widthPx - BLOCK_CHROME_PX - (args.reservedPx ?? 0);
  const titlePx = titleChars * TITLE_CHAR_PX;
  if (titlePx + BADGE_GAP_PX * 2 + rowWidth(shown, more) <= avail) {
    return { where: 'inline', shown, more };
  }
  if (tier !== 'full') return HIDDEN;
  const lines = Math.min(2, Math.max(1, Math.ceil(titlePx / Math.max(avail, 1))));
  const needed =
    BLOCK_PAD_PX + lines * TITLE_LINE_PX + (args.textRows ?? 0) * TEXT_ROW_PX + BADGE_ROW_PX;
  if (heightPx < needed) return HIDDEN;
  // Fit as many as the row allows; the remainder collapses into "+N".
  for (let n = shown; n >= 1; n--) {
    const m = count - n;
    if (rowWidth(n, m) <= avail) return { where: 'below', shown: n, more: m };
  }
  return HIDDEN;
}
