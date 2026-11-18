import { AdvancedMarker, useMap } from '@vis.gl/react-google-maps';
import { useEffect, useReducer, useRef } from 'react';
import { LocateFixed, Navigation } from 'lucide-react';
import { IconButton } from '../ui/IconButton';
import { locateReducer, showAccuracyCircle } from './locate';
import { cssVar } from './cssVar';
import styles from './LocateControl.module.css';

const LOCATE_ZOOM = 14;

/**
 * Current-location control. Nothing asks for geolocation until the button is pressed. While on,
 * it watches the position and draws a dot plus accuracy circle (both non-interactive, so map
 * drags and pans pass through them; checked in headless Chrome: a long press on the dot itself does not start an Add, because AddAtPoint ignores events from the advanced-marker element, while one beside it does). The position never feeds the markers model,
 * so it never triggers a refit.
 */
export function LocateControl() {
  const map = useMap();
  const [state, dispatch] = useReducer(locateReducer, { status: 'off' });
  const watching = state.status === 'requesting' || state.status === 'on';
  const centred = useRef(false);

  useEffect(() => {
    if (!watching) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      dispatch({ type: 'error', code: 'unsupported' });
      return;
    }
    centred.current = false;
    const id = navigator.geolocation.watchPosition(
      (p) =>
        dispatch({
          type: 'position',
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracy: p.coords.accuracy,
        }),
      (e) => dispatch({ type: 'error', code: e.code }),
      // High accuracy for a useful dot while the user has asked for it; maximumAge lets the first
      // fix come from a recent cached position, and the timeout only raises a transient note.
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [watching]);

  const liveText =
    state.status === 'denied'
      ? state.message
      : state.status === 'requesting' || state.status === 'on'
        ? (state.note ?? (state.status === 'requesting' ? 'Locating…' : ''))
        : '';
  const on = state.status === 'on';
  const lat = on ? state.lat : undefined;
  const lng = on ? state.lng : undefined;
  const accuracy = on ? state.accuracy : 0;

  const goTo = (la: number, ln: number) => {
    if (!map) return;
    map.panTo({ lat: la, lng: ln });
    if ((map.getZoom() ?? 0) < LOCATE_ZOOM) map.setZoom(LOCATE_ZOOM);
  };

  // A drag while locating means the user is steering: skip the first-fix auto-centre.
  useEffect(() => {
    if (!map || !watching) return;
    const l = map.addListener('dragstart', () => {
      centred.current = true;
    });
    return () => l.remove();
  }, [map, watching]);

  // Centre once on the first fix after turning on; after that the user drives, via re-centre.
  useEffect(() => {
    if (!map || lat === undefined || lng === undefined || centred.current) return;
    centred.current = true;
    map.panTo({ lat, lng });
    if ((map.getZoom() ?? 0) < LOCATE_ZOOM) map.setZoom(LOCATE_ZOOM);
  }, [map, lat, lng]);

  useEffect(() => {
    if (!map || lat === undefined || lng === undefined || !showAccuracyCircle(accuracy)) return;
    // Maps overlays take colour strings; resolve the token now (the map remounts on a theme change).
    const accent = cssVar('--accent', '#2f5fe0');
    const c = new google.maps.Circle({
      map,
      center: { lat, lng },
      radius: accuracy,
      clickable: false,
      strokeWeight: 1,
      strokeColor: accent,
      strokeOpacity: 0.55,
      fillColor: accent,
      fillOpacity: 0.14,
    });
    return () => c.setMap(null);
  }, [map, lat, lng, accuracy]);

  return (
    <>
      <div className={styles.control}>
        <IconButton
          variant={watching ? 'primary' : 'secondary'}
          className={styles.btn}
          data-active={watching || undefined}
          aria-pressed={watching}
          label="Show my location"
          title={watching ? 'Turn off current location' : 'Show my location'}
          data-testid="locate-toggle"
          onClick={() => dispatch({ type: watching ? 'stop' : 'start' })}
        >
          <LocateFixed size={18} aria-hidden="true" />
        </IconButton>
        {lat !== undefined && lng !== undefined && (
          <IconButton
            variant="secondary"
            className={styles.btn}
            label="Re-centre on my location"
            data-testid="locate-recentre"
            onClick={() => goTo(lat, lng)}
          >
            <Navigation size={18} aria-hidden="true" />
          </IconButton>
        )}
        <p
          className={styles.msg}
          role="status"
          aria-live="polite"
          data-empty={!liveText || undefined}
          data-testid="locate-message"
        >
          {liveText}
        </p>
      </div>
      {lat !== undefined && lng !== undefined && (
        <AdvancedMarker position={{ lat, lng }} clickable={false} zIndex={1000}>
          <div className={styles.dot} data-testid="locate-dot" aria-hidden="true" />
        </AdvancedMarker>
      )}
    </>
  );
}
