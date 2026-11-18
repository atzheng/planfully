import type { Event, EventType } from '@planfully/shared';
import { TYPE_ICON, eventIcon } from '../timeline/model';
import styles from './ui.module.css';

/** Decorative line icon for an event (by transit mode / type) or a bare type. Hidden from assistive tech. */
export function EventIcon({
  event,
  type,
  size = 16,
}: {
  event?: Pick<Event, 'type' | 'mode'>;
  type?: EventType;
  size?: number;
}) {
  const Icon = event ? eventIcon(event) : TYPE_ICON[type ?? 'other'];
  return <Icon className={styles.eventIcon} size={size} strokeWidth={2} aria-hidden="true" />;
}
