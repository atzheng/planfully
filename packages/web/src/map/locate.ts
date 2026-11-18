/** Pure logic for the current-location control: state machine and accuracy helpers. */

export type LocateState =
  | { status: 'off' }
  | { status: 'requesting' }
  | { status: 'on'; lat: number; lng: number; accuracy: number }
  | { status: 'denied'; message: string };

export type LocateAction =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'position'; lat: number; lng: number; accuracy: number }
  | { type: 'error'; code: number | 'unsupported' };

/** Codes are GeolocationPositionError: 1 permission denied, 2 unavailable, 3 timeout. */
export function errorMessage(code: number | 'unsupported'): string {
  switch (code) {
    case 1:
      return 'Location permission denied';
    case 'unsupported':
      return 'Location is not available on this device';
    case 3:
      return 'Location timed out';
    default:
      return 'Location unavailable';
  }
}

export function locateReducer(state: LocateState, a: LocateAction): LocateState {
  switch (a.type) {
    case 'start':
      return state.status === 'off' || state.status === 'denied' ? { status: 'requesting' } : state;
    case 'stop':
      return { status: 'off' };
    case 'position':
      // A late fix after the user turned the control off is ignored.
      return state.status === 'off' || state.status === 'denied'
        ? state
        : { status: 'on', lat: a.lat, lng: a.lng, accuracy: sanitizeAccuracy(a.accuracy) };
    case 'error':
      // Any failure returns the control to off, with a short message.
      return state.status === 'off' ? state : { status: 'denied', message: errorMessage(a.code) };
  }
}

/** Accuracy circle radius in metres: finite, at least 1 m (a 0 radius is invalid). */
export function sanitizeAccuracy(accuracy: number): number {
  return Number.isFinite(accuracy) && accuracy > 1 ? accuracy : 1;
}

/** True when the accuracy circle is big enough to be worth drawing next to the dot. */
export function showAccuracyCircle(accuracy: number): boolean {
  return accuracy >= 5;
}
