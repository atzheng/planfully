// Human-readable labels for enum values shown in the sheet and form.
import type { Event, EventType, TransitMode } from '@planfully/shared';

export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export const typeLabel = (t: EventType): string => capitalize(t);

export const modeLabel = (m: TransitMode): string => capitalize(m);

export const statusLabel = (s: Event['status']): string => capitalize(s);

/** 'Flight' for a transit event with a mode, else the title-cased type. */
export function kindLabel(e: Pick<Event, 'type' | 'mode'>): string {
  return e.type === 'transit' && e.mode && e.mode !== 'other'
    ? modeLabel(e.mode)
    : typeLabel(e.type);
}

/** Up to two initials of a name, upper-cased. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

/** 'Lisbon' for 'Europe/Lisbon'; the quiet label on the zone button. */
export function zoneCity(tz: string): string {
  const last = tz.split('/').pop() ?? tz;
  return last.replace(/_/g, ' ');
}
