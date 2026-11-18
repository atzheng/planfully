import { MarkerClusterer } from '@googlemaps/markerclusterer';
import { AdvancedMarker, APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAddEvent } from '../event/AddEvent';
import { stringCodec, useQueryState } from '../lib/queryState';
import { useFilteredEvents } from '../filters/filter';
import { TYPE_HUE, TYPE_ICON } from '../timeline/model';
import { boundsKey, buildMapModel, locatedEvents, type MapModel } from './markers';
import { LocateControl } from './LocateControl';
import { mapColorScheme } from '../theme/theme';
import { useTheme } from '../theme/useTheme';
import styles from './MapView.module.css';

/** Google's demo map id enables advanced markers without a Cloud-styled map. */
const DEFAULT_MAP_ID = 'DEMO_MAP_ID';
const FIT_PADDING = 48;
const FIT_MAX_ZOOM = 15;

type Env = { VITE_GOOGLE_MAPS_KEY?: string; VITE_GOOGLE_MAP_ID?: string };
const env = import.meta.env as Env;

const pinColors = (type: keyof typeof TYPE_HUE) => ({
  background: `hsl(${TYPE_HUE[type]} 60% 45%)`,
  border: `hsl(${TYPE_HUE[type]} 60% 25%)`,
});

function usePrefersDark(): boolean {
  return useTheme().resolved === 'dark';
}

/**
 * Map view. `children` render inside the map (inside the Maps API context), so later beads can add
 * layers such as a current-location dot with `useMap()` without touching this file.
 */
export function MapView({ children }: { children?: ReactNode }) {
  const apiKey = env.VITE_GOOGLE_MAPS_KEY?.trim();
  const events = useFilteredEvents();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!apiKey) return;
    // Maps calls this global on key / referrer failures; onError does not cover them.
    const w = window as unknown as { gm_authFailure?: () => void };
    const prev = w.gm_authFailure;
    w.gm_authFailure = () => setFailed(true);
    return () => {
      w.gm_authFailure = prev;
    };
  }, [apiKey]);
  const [, setOpen] = useQueryState('e', stringCodec, '');

  if (!apiKey) return <LocatedList events={events} notice="Map key not configured" />;
  return (
    <div className={styles.wrap}>
      {failed ? (
        <LocatedList events={events} notice="Map couldn't load" />
      ) : (
        <APIProvider apiKey={apiKey} onError={() => setFailed(true)}>
          <MapCanvas events={events} onOpen={setOpen}>
            {children}
          </MapCanvas>
        </APIProvider>
      )}
    </div>
  );
}

function MapCanvas({
  events,
  onOpen,
  children,
}: {
  events: ReturnType<typeof useFilteredEvents>;
  onOpen: (id: string) => void;
  children?: ReactNode;
}) {
  const dark = usePrefersDark();
  const model = useMemo(() => buildMapModel(events), [events]);
  return (
    <div className={styles.canvas} data-testid="map">
      <Map
        // colorScheme is read once at creation, so a theme change remounts the map.
        key={dark ? 'dark' : 'light'}
        mapId={env.VITE_GOOGLE_MAP_ID || DEFAULT_MAP_ID}
        colorScheme={mapColorScheme(dark ? 'dark' : 'light')}
        defaultCenter={{ lat: 20, lng: 0 }}
        defaultZoom={2}
        gestureHandling="greedy"
        disableDefaultUI={false}
        streetViewControl={false}
        mapTypeControl={false}
        fullscreenControl={false}
        style={{ width: '100%', height: '100%' }}
      >
        <FitBounds model={model} />
        <Paths model={model} />
        <ClusteredMarkers model={model} onOpen={onOpen} />
        <AddAtPoint />
        <LocateControl />
        {children}
      </Map>
      {model.markers.length === 0 && (
        <p className={styles.empty} role="status">
          No located events to show
        </p>
      )}
    </div>
  );
}

/** Refits when the bounds of the filtered set change, not on every render. */
function FitBounds({ model }: { model: MapModel }) {
  const map = useMap();
  const key = boundsKey(model.bounds);
  const bounds = useRef(model.bounds);
  bounds.current = model.bounds;
  useEffect(() => {
    const b = bounds.current;
    if (!map || !b) return;
    // Cap the zoom so a single place does not fit to street level.
    map.setOptions({ maxZoom: FIT_MAX_ZOOM });
    map.fitBounds(b, FIT_PADDING);
    const l = map.addListener('idle', () => {
      map.setOptions({ maxZoom: null });
      l.remove();
    });
    return () => {
      l.remove();
      map.setOptions({ maxZoom: null });
    };
  }, [map, key]);
  return null;
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

/**
 * Right-click, or a long press on touch, on the map surface starts a new event at that point.
 * Uses the Maps API's own events for the position, and ignores any that started on a marker,
 * cluster, control or info window so those keep their own behaviour (and context menus).
 */
const NOT_SURFACE = 'gmp-advanced-marker, [role="button"], button, a, .gmnoprint, .gm-style-iw';
function onBareMap(e: google.maps.MapMouseEvent): boolean {
  const dom = e.domEvent as Event | undefined;
  const path = dom?.composedPath?.() ?? [];
  return !path.some((n) => n instanceof Element && n.matches(NOT_SURFACE));
}

function AddAtPoint() {
  const map = useMap();
  const add = useAddEvent();
  const addRef = useRef(add);
  addRef.current = add;
  useEffect(() => {
    const div = map?.getDiv();
    if (!map || !div) return;
    const open = (ll: google.maps.LatLng | null | undefined) => {
      if (ll) addRef.current?.openAtPoint(ll.lat(), ll.lng());
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let origin: { x: number; y: number } | null = null;
    let lastType = 'mouse';
    const down = new Set<number>();
    /** Set when a second finger joins: no press starts again until every pointer is up. */
    let blocked = false;
    const cancel = () => {
      clearTimeout(timer);
      origin = null;
    };
    // Pointer bookkeeping only (no preventDefault): which pointers are down, and where.
    const onDown = (e: PointerEvent) => {
      down.add(e.pointerId);
      lastType = e.pointerType;
      if (down.size > 1) {
        blocked = true;
        cancel();
      } else if (e.isPrimary) {
        origin = { x: e.clientX, y: e.clientY };
      }
    };
    const onMove = (e: PointerEvent) => {
      if (
        origin &&
        e.isPrimary &&
        Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > LONG_PRESS_SLOP_PX
      ) {
        cancel();
      }
    };
    const onUp = (e: PointerEvent) => {
      down.delete(e.pointerId);
      if (down.size === 0) blocked = false;
      cancel();
    };
    div.addEventListener('pointerdown', onDown, true);
    div.addEventListener('pointermove', onMove, true);
    div.addEventListener('pointerup', onUp, true);
    div.addEventListener('pointercancel', onUp, true);

    const listeners = [
      map.addListener('contextmenu', (e: google.maps.MapMouseEvent) => {
        if (!onBareMap(e)) return;
        // A touch long press can raise this too; the provider opens only once.
        (e.domEvent as Event | undefined)?.preventDefault?.();
        open(e.latLng);
      }),
      map.addListener('mousedown', (e: google.maps.MapMouseEvent) => {
        if (lastType === 'mouse' || blocked || down.size !== 1 || !onBareMap(e)) return;
        clearTimeout(timer);
        const ll = e.latLng;
        timer = setTimeout(() => {
          origin = null;
          open(ll);
        }, LONG_PRESS_MS);
      }),
      map.addListener('mouseup', cancel),
      map.addListener('dragstart', cancel),
      map.addListener('zoom_changed', cancel),
    ];
    return () => {
      cancel();
      listeners.forEach((l) => l.remove());
      div.removeEventListener('pointerdown', onDown, true);
      div.removeEventListener('pointermove', onMove, true);
      div.removeEventListener('pointerup', onUp, true);
      div.removeEventListener('pointercancel', onUp, true);
    };
  }, [map]);
  return null;
}

function Paths({ model }: { model: MapModel }) {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    const lines = model.paths.map(
      (p) =>
        new google.maps.Polyline({
          map,
          path: [p.from, p.to],
          geodesic: true,
          strokeColor: pinColors(p.type).background,
          strokeOpacity: 0.85,
          strokeWeight: 3,
        }),
    );
    return () => lines.forEach((l) => l.setMap(null));
  }, [map, model.paths]);
  return null;
}

type MarkerEl = google.maps.marker.AdvancedMarkerElement;

function ClusteredMarkers({ model, onOpen }: { model: MapModel; onOpen: (id: string) => void }) {
  const map = useMap();
  const [els, setEls] = useState<Record<string, MarkerEl>>({});
  const clusterer = useRef<MarkerClusterer | null>(null);

  useEffect(() => {
    if (!map) return;
    clusterer.current ??= new MarkerClusterer({ map });
    return () => {
      clusterer.current?.clearMarkers();
      clusterer.current?.onRemove();
      clusterer.current = null;
    };
  }, [map]);

  useEffect(() => {
    clusterer.current?.clearMarkers();
    clusterer.current?.addMarkers(Object.values(els));
  }, [els]);

  // One stable callback per key: a new ref function each render would be called with null then the
  // element again, setting state on every render.
  const refs = useRef(new globalThis.Map<string, (el: MarkerEl | null) => void>());
  const setRef = (key: string) => {
    let cb = refs.current.get(key);
    if (!cb) {
      cb = (el) =>
        setEls((prev) => {
          if (el ? prev[key] === el : !(key in prev)) return prev;
          const next = Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key));
          if (el) next[key] = el;
          return next;
        });
      refs.current.set(key, cb);
    }
    return cb;
  };

  return (
    <>
      {model.markers.map((m) => {
        const key = `${m.eventId}:${m.role}`;
        const c = pinColors(m.type);
        return (
          <AdvancedMarker
            key={key}
            ref={setRef(key)}
            position={{ lat: m.lat, lng: m.lng }}
            title={m.label}
            onClick={() => onOpen(m.eventId)}
          >
            <div
              className={styles.pin}
              style={{ background: c.background, borderColor: c.border }}
              aria-hidden="true"
            >
              {TYPE_ICON[m.type]}
            </div>
          </AdvancedMarker>
        );
      })}
    </>
  );
}

/** Fallback when the map cannot be shown: a notice and a plain list of located events. */
function LocatedList({
  events,
  notice,
}: {
  events: ReturnType<typeof useFilteredEvents>;
  notice: string;
}) {
  const [, setOpen] = useQueryState('e', stringCodec, '');
  const located = locatedEvents(events);
  return (
    <div className={styles.fallback}>
      <p role="status" className={styles.notice}>
        {notice}
      </p>
      {located.length === 0 ? (
        <p>No located events.</p>
      ) : (
        <ul className={styles.list} data-testid="located-list">
          {located.map((e) => {
            const place = e.location?.name ?? e.location?.address ?? e.endLocation?.name;
            return (
              <li key={e.id}>
                <button type="button" className={styles.item} onClick={() => setOpen(e.id)}>
                  <span aria-hidden="true">{TYPE_ICON[e.type]}</span>
                  <span className={styles.itemText}>
                    <span className={styles.itemName}>{e.name}</span>
                    {place && <span className={styles.itemPlace}>{place}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
