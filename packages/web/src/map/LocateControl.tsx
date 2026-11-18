import { AdvancedMarker, useMap } from '@vis.gl/react-google-maps';
import { useEffect, useReducer, useRef } from 'react';
import { locateReducer, showAccuracyCircle } from './locate';
import styles from './LocateControl.module.css';

const LOCATE_ZOOM = 14;

/**
 * Current-location control. Nothing asks for geolocation until the button is pressed. While on,
 * it watches the position and draws a dot plus accuracy circle (both non-interactive, so map
 * gestures and long-press-to-add pass through them). The position never feeds the markers model,
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
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [watching]);

  const on = state.status === 'on';
  const lat = on ? state.lat : undefined;
  const lng = on ? state.lng : undefined;
  const accuracy = on ? state.accuracy : 0;

  const goTo = (la: number, ln: number) => {
    if (!map) return;
    map.panTo({ lat: la, lng: ln });
    if ((map.getZoom() ?? 0) < LOCATE_ZOOM) map.setZoom(LOCATE_ZOOM);
  };

  // Centre once on the first fix after turning on; after that the user drives, via re-centre.
  useEffect(() => {
    if (!map || lat === undefined || lng === undefined || centred.current) return;
    centred.current = true;
    map.panTo({ lat, lng });
    if ((map.getZoom() ?? 0) < LOCATE_ZOOM) map.setZoom(LOCATE_ZOOM);
  }, [map, lat, lng]);

  useEffect(() => {
    if (!map || lat === undefined || lng === undefined || !showAccuracyCircle(accuracy)) return;
    const c = new google.maps.Circle({
      map,
      center: { lat, lng },
      radius: accuracy,
      clickable: false,
      strokeWeight: 1,
      strokeColor: '#2a6df4',
      strokeOpacity: 0.5,
      fillColor: '#2a6df4',
      fillOpacity: 0.15,
    });
    return () => c.setMap(null);
  }, [map, lat, lng, accuracy]);

  return (
    <>
      <div className={styles.control}>
        <button
          type="button"
          className={styles.btn}
          data-active={watching || undefined}
          aria-pressed={watching}
          aria-label={watching ? 'Turn off current location' : 'Show my location'}
          title={watching ? 'Turn off current location' : 'Show my location'}
          data-testid="locate-toggle"
          onClick={() => dispatch({ type: watching ? 'stop' : 'start' })}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <circle cx="12" cy="12" r="3.5" fill="currentColor" />
            <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
        {lat !== undefined && lng !== undefined && (
          <button
            type="button"
            className={styles.btn}
            aria-label="Re-centre on my location"
            title="Re-centre on my location"
            data-testid="locate-recentre"
            onClick={() => goTo(lat, lng)}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M12 3l7 17-7-4-7 4z" fill="currentColor" />
            </svg>
          </button>
        )}
        {state.status === 'denied' && (
          <p className={styles.msg} role="status" data-testid="locate-message">
            {state.message}
          </p>
        )}
        {state.status === 'requesting' && (
          <p className={styles.msg} role="status">
            Locating…
          </p>
        )}
      </div>
      {lat !== undefined && lng !== undefined && (
        <AdvancedMarker position={{ lat, lng }} clickable={false} zIndex={1000}>
          <div className={styles.dot} data-testid="locate-dot" aria-hidden="true" />
        </AdvancedMarker>
      )}
    </>
  );
}
