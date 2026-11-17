import { useTrip } from '../trip/store';

// Temporary: replaced by planfully-gy4.6.
export function Timeline() {
  const count = useTrip((s) => s.events.length);
  return <div>{count} events</div>;
}
