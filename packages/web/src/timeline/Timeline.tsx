import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Event, EventType, RosterMember } from '@planfully/shared';
import { useFilteredEvents } from '../filters/filter';
import {
  booleanCodec,
  enumCodec,
  stringCodec,
  stringListCodec,
  useQueryState,
} from '../lib/queryState';
import { useRegisterCentre } from '../event/AddEvent';
import { useTrip } from '../trip/store';
import { bucketLabel, compactBuckets, isCompact } from './compact';
import { EventIcon } from '../ui/EventIcon';
import type { Bucket } from './compact';
import { initialScrollMs, LANE_MODES, layoutEvents, withoutEmptyLanes } from './layout';
import type { Layout, LaneMode } from './layout';
import { dayHeading, localStartLabel, roundRangeToHours, timelineRange, validZone } from './model';
import { anchorMsAt, scrollTopForAnchor } from './model';
import {
  makeScale,
  MAX_PX_PER_HOUR,
  MIN_PX_PER_HOUR,
  ticks,
  TimeScaleProvider,
  VisibleRangeProvider,
} from './scale';
import type { Tick, TimeScale, VisibleRange } from './scale';
import {
  attachGestureZoom,
  buttonPx,
  fitPx,
  pinchPx,
  scrollTopForPointer,
  showSecondary,
  useZoom,
  wheelPx,
} from './zoom';
import { TimeZonePicker } from './TimeZonePicker';
import { WEATHER_GUTTER_PX, WeatherLegend, WeatherStrip } from './WeatherStrip';
import styles from './Timeline.module.css';

/** Height of the sticky day heading; the canvas starts below it. */
const HEADING_PX = 28;
/** Height of the sticky lane header row (only present in a lane mode). */
const LANE_HEAD_PX = 32;
const LANE_MODE_LABEL: Record<LaneMode, string> = {
  none: 'Single',
  type: 'By type',
  participant: 'By person',
};
const laneModeCodec = enumCodec(LANE_MODES);
/** Context kept above the target when scrolling to a time. */
const SCROLL_LEAD_PX = 48;
const NO_ROSTER: readonly RosterMember[] = [];
const NO_WHO: string[] = [];
const NO_BLOCKS: Layout['blocks'] = [];
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const Blocks = memo(function Blocks({
  blocks,
  byId,
  onOpen,
}: {
  blocks: Layout['blocks'];
  byId: Map<string, Event>;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      {blocks.map((b) => {
        const e = byId.get(b.eventId);
        if (!e) return null;
        const time = localStartLabel(e);
        const cancelled = e.status === 'cancelled';
        const secondary = showSecondary(b.height);
        return (
          <button
            key={`${b.laneKey}:${b.eventId}`}
            type="button"
            className={`${styles.block} ${cancelled ? styles.cancelled : ''} ${secondary ? '' : styles.compact}`}
            data-testid="block"
            data-event-id={e.id}
            data-type={e.type}
            style={{
              top: b.top,
              height: b.height,
              left: `calc(${(b.column / b.columns) * 100}% + 1px)`,
              width: `calc(${100 / b.columns}% - 2px)`,
            }}
            onClick={() => onOpen(e.id)}
          >
            <span className={styles.blockLabel}>
              <span className={styles.blockIcon} aria-hidden="true">
                <EventIcon event={e} />
              </span>
              <span className={styles.blockText}>
                <span className={styles.blockName}>{e.name}</span>
                {time && secondary && <span className={styles.blockTime}>{time}</span>}
                {cancelled && <span className={styles.srOnly}> (cancelled)</span>}
              </span>
            </span>
            {e.needsReview && (
              <span
                className={styles.review}
                title="Needs review"
                role="img"
                aria-label="Needs review"
              >
                !
              </span>
            )}
          </button>
        );
      })}
    </>
  );
});

const NO_BUCKETS: Bucket[] = [];
const MAX_CHIP_ICONS = 3;

/** Low-zoom summary chips for one lane; a chip opens a small list of its events (planfully-ieq). */
const Chips = memo(function Chips({
  buckets,
  byId,
  zone,
  onOpen,
}: {
  buckets: Bucket[];
  byId: Map<string, Event>;
  zone: string;
  onOpen: (id: string) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  /** Close the list; `refocus` returns focus to its chip (Escape, toggle) but not after picking an event. */
  const close = useCallback(
    (refocus: boolean) => {
      if (refocus && openKey) chipRefs.current.get(openKey)?.focus();
      setOpenKey(null);
    },
    [openKey],
  );
  useEffect(() => {
    const el = root.current;
    if (!openKey || !el) return;
    el.querySelector<HTMLButtonElement>('[data-testid=chip-item]')?.focus();
    const onDown = (ev: PointerEvent) => {
      if (!el.contains(ev.target as Node)) setOpenKey(null);
    };
    // On the wrapper (not document) so an open event sheet does not also see this Escape.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', onDown);
    el.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      el.removeEventListener('keydown', onKey);
    };
  }, [openKey, close]);
  return (
    <div ref={root}>
      {buckets.map((b) => {
        const open = openKey === b.key;
        const label = bucketLabel(b.eventIds.length, b.unit, b.startMs, zone);
        return (
          <div key={b.key}>
            <button
              type="button"
              className={`${styles.chip} ${open ? styles.chipOpen : ''}`}
              data-testid="chip"
              ref={(n) => {
                if (n) chipRefs.current.set(b.key, n);
                else chipRefs.current.delete(b.key);
              }}
              style={{ top: b.top, height: b.height }}
              aria-label={label}
              aria-expanded={open}
              onClick={() => (open ? close(true) : setOpenKey(b.key))}
            >
              <span className={styles.chipCount}>{b.eventIds.length}</span>
              <span className={styles.chipIcons} aria-hidden="true">
                {b.types.slice(0, MAX_CHIP_ICONS).map((t) => (
                  <EventIcon key={t} type={t} size={14} />
                ))}
                {b.types.length > MAX_CHIP_ICONS ? '…' : ''}
              </span>
            </button>
            {open && (
              <ul
                className={styles.chipList}
                data-testid="chip-list"
                style={{ top: b.top + b.height + 2 }}
                aria-label={label}
              >
                {b.eventIds.map((id) => {
                  const e = byId.get(id);
                  if (!e) return null;
                  const time = localStartLabel(e);
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        className={`${styles.chipItem} ${e.status === 'cancelled' ? styles.cancelled : ''}`}
                        data-testid="chip-item"
                        data-event-id={id}
                        onClick={() => {
                          close(false);
                          onOpen(id);
                        }}
                      >
                        <EventIcon event={e} />
                        <span className={styles.chipItemName}>{e.name}</span>
                        {time && <span className={styles.blockTime}>{time}</span>}
                        {e.status === 'cancelled' && (
                          <span className={styles.srOnly}> (cancelled)</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
});

const Ticks = memo(function Ticks({ list, scale }: { list: Tick[]; scale: TimeScale }) {
  return (
    <>
      {list.map((t) => (
        <div
          key={t.ms}
          className={`${styles.tick} ${styles[t.kind]}`}
          style={{ top: scale.toY(t.ms) }}
        />
      ))}
    </>
  );
});

const TickLabels = memo(function TickLabels({ list, scale }: { list: Tick[]; scale: TimeScale }) {
  return (
    <>
      {list.map((t) => (
        <span
          key={t.ms}
          className={`${styles.tickLabel} ${styles[t.kind]}`}
          style={{ top: scale.toY(t.ms) + 2 }}
        >
          {t.label}
        </span>
      ))}
    </>
  );
});

export function Timeline({ gutter: gutterProp }: { gutter?: ReactNode } = {}) {
  const events = useFilteredEvents();
  const totalEvents = useTrip((s) => s.events.length);
  const roster = useTrip((s) => s.meta?.roster) ?? NO_ROSTER;
  const allEvents = useTrip((s) => s.events);
  const [tzRaw, setTzRaw] = useQueryState('tz', stringCodec, '');
  const [, setOpenId] = useQueryState('e', stringCodec, '');
  const [who] = useQueryState('who', stringListCodec, NO_WHO);
  const [laneMode, setLaneMode] = useQueryState('lanes', laneModeCodec, 'none');
  const [wxOn, setWxOn] = useQueryState('wx', booleanCodec, false);
  const { pxPerHour, setPx } = useZoom();
  const gutter = wxOn ? <WeatherStrip /> : gutterProp;
  const gutterPx = wxOn ? WEATHER_GUTTER_PX : 64;

  const zone = useMemo(() => validZone(tzRaw, browserZone()), [tzRaw]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const range = useMemo(() => timelineRange(events, zone), [events, zone]);
  // While the filter empties the view, keep the last scale and canvas height so the scroll position survives.
  const lastScale = useRef<TimeScale | null>(null);
  const lastHeight = useRef(0);
  const scale = useMemo(
    () =>
      range
        ? makeScale(range.fromMs, pxPerHour)
        : (lastScale.current ?? makeScale(Date.now(), pxPerHour)),
    [range, pxPerHour],
  );
  if (range) lastScale.current = scale;
  const layout = useMemo(
    () =>
      withoutEmptyLanes(
        layoutEvents(events, scale, { mode: laneMode, roster, only: who }),
        laneMode,
      ),
    [events, scale, roster, laneMode, who],
  );
  const blocksByLane = useMemo(() => {
    const m = new Map<string, Layout['blocks']>();
    for (const b of layout.blocks) {
      const list = m.get(b.laneKey);
      if (list) list.push(b);
      else m.set(b.laneKey, [b]);
    }
    return m;
  }, [layout]);
  const compact = isCompact(pxPerHour);
  const bucketsByLane = useMemo(() => {
    const m = new Map<string, Bucket[]>();
    if (!compact || !range) return m;
    const byEvent = new Map(events.map((e) => [e.id, e]));
    for (const b of compactBuckets(layout, byEvent, scale, zone, scale.toY(range.toMs))) {
      const list = m.get(b.laneKey);
      if (list) list.push(b);
      else m.set(b.laneKey, [b]);
    }
    return m;
  }, [compact, layout, events, scale, zone, range]);
  const laneHead = laneMode === 'none' ? 0 : LANE_HEAD_PX;
  /** Scroller y at which the time axis starts (day heading plus lane header row). */
  const topPx = HEADING_PX + laneHead;
  const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const tickList = useMemo(
    () => (range ? ticks(scale, range.fromMs, range.toMs, zone) : []),
    [range, scale, zone],
  );
  const height = range ? scale.toY(range.toMs) : lastHeight.current;
  if (range) lastHeight.current = height;

  const scroller = useRef<HTMLDivElement>(null);
  // Never empty (fromMs < toMs), even on the first frame; the layout effect below corrects it before paint.
  const [visible, setVisible] = useState<VisibleRange>(() => ({
    fromMs: scale.originMs,
    toMs: scale.originMs + 24 * 3_600_000,
  }));
  const anchorMs = useRef<number | null>(null);
  /** Screen y (below the scroller top) at which `anchorMs` must stay after a scale change. */
  const anchorY = useRef(0);
  const [headingMs, setHeadingMs] = useState(scale.originMs);
  // The Add button starts new events at the middle of what is on screen.
  useRegisterCentre(() => {
    const el = scroller.current;
    if (!el || !range) return null;
    // The scroller can extend below the window: take the middle of the part actually on screen.
    const r = el.getBoundingClientRect();
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const mid = bottom > top ? (top + bottom) / 2 - r.top : el.clientHeight / 2;
    return { ms: scale.toMs(el.scrollTop + mid - topPx), tz: zone };
  });

  const scrollToMs = useCallback(
    (ms: number, behavior: ScrollBehavior = 'smooth') => {
      scroller.current?.scrollTo({
        top: Math.max(0, scale.toY(ms) + topPx - SCROLL_LEAD_PX),
        behavior,
      });
    },
    [scale, topPx],
  );

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el || !range) return;
    anchorMs.current = anchorMsAt(scale, el.scrollTop, topPx);
    anchorY.current = 0;
    const topMs = scale.toMs(el.scrollTop - topPx);
    const botMs = scale.toMs(el.scrollTop + el.clientHeight - topPx);
    const r = roundRangeToHours(topMs, botMs);
    setVisible((v) => (v.fromMs === r.fromMs && v.toMs === r.toMs ? v : r));
    const h = Math.min(Math.max(topMs, scale.originMs), range?.toMs ?? scale.originMs);
    setHeadingMs(Math.floor(h / 60_000) * 60_000);
  }, [scale, range, topPx]);

  // Open at today (or the trip's first day), once, when the axis first exists.
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    if (scrolled.current || !range) return;
    scrolled.current = true;
    scrollToMs(initialScrollMs(events, Date.now()), 'auto');
    anchorMs.current = anchorMsAt(scale, scroller.current?.scrollTop ?? 0, topPx);
  }, [range, events, scrollToMs, scale, topPx]);
  // Keep the time at the top of the viewport at the same screen y when the scale changes (filters, zoom).
  const lastAnchoredScale = useRef(scale);
  const lastTopPx = useRef(topPx);
  useLayoutEffect(() => {
    const el = scroller.current;
    const changed = lastAnchoredScale.current !== scale || lastTopPx.current !== topPx;
    lastTopPx.current = topPx;
    if (range && el && changed && anchorMs.current !== null) {
      el.scrollTop =
        anchorY.current === 0
          ? scrollTopForAnchor(scale, anchorMs.current, topPx)
          : scrollTopForPointer(scale, anchorMs.current, topPx, anchorY.current);
    }
    if (range) lastAnchoredScale.current = scale;
    measure();
  }, [measure, height, scale, range, topPx]);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  // ---- Zoom -------------------------------------------------------------------------------------
  const pxRef = useRef(pxPerHour);
  pxRef.current = pxPerHour;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const rangeRef = useRef(range);
  rangeRef.current = range;

  /** Zoom to `px`, keeping the instant `ms` (default: the one under screen y `y`) at screen y `y`. */
  const zoomTo = useCallback(
    (px: number, y: number, ms?: number) => {
      const el = scroller.current;
      if (!el) return;
      const anchor = ms ?? scaleRef.current.toMs(el.scrollTop + y - topPx);
      anchorMs.current = anchor;
      anchorY.current = y;
      pxRef.current = px;
      setPx(px);
    },
    [setPx, topPx],
  );
  const centreY = () => (scroller.current?.clientHeight ?? 0) / 2;
  const zoomButton = (dir: 1 | -1) => zoomTo(buttonPx(pxRef.current, dir), centreY());
  const fitTrip = () => {
    const r = rangeRef.current;
    const el = scroller.current;
    if (!r || !el) return;
    zoomTo(fitPx(r.fromMs, r.toMs, el.clientHeight - topPx), topPx, r.fromMs);
  };

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const yOf = (clientY: number) => clientY - el.getBoundingClientRect().top;
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      zoomTo(wheelPx(pxRef.current, ev.deltaY, ev.deltaMode), yOf(ev.clientY));
    };
    let pinch: { dist: number; px: number; ms: number } | null = null;
    const dist = (t: TouchList) =>
      Math.hypot(
        (t[0]?.clientX ?? 0) - (t[1]?.clientX ?? 0),
        (t[0]?.clientY ?? 0) - (t[1]?.clientY ?? 0),
      );
    const midY = (t: TouchList) => yOf(((t[0]?.clientY ?? 0) + (t[1]?.clientY ?? 0)) / 2);
    const onStart = (ev: TouchEvent) => {
      if (ev.touches.length === 2) {
        pinch = {
          dist: dist(ev.touches),
          px: pxRef.current,
          ms: scaleRef.current.toMs(el.scrollTop + midY(ev.touches) - topPx),
        };
      } else pinch = null;
    };
    const onMove = (ev: TouchEvent) => {
      if (!pinch || ev.touches.length !== 2) return;
      ev.preventDefault();
      zoomTo(pinchPx(pinch.px, pinch.dist, dist(ev.touches)), midY(ev.touches), pinch.ms);
    };
    const onEnd = (ev: TouchEvent) => {
      if (ev.touches.length < 2) pinch = null;
    };
    const detachGesture = attachGestureZoom(
      el,
      () => pxRef.current,
      (px, clientY) => zoomTo(px, yOf(clientY)),
    );
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      detachGesture();
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [zoomTo]);

  const todayTarget =
    range && nowMs >= range.fromMs && nowMs <= range.toMs ? nowMs : initialScrollMs(events, nowMs);
  const showNow = !!range && nowMs >= range.fromMs && nowMs <= range.toMs;

  const empty = events.length === 0;
  return (
    <section className={styles.timeline} aria-label="Timeline">
      <div className={styles.toolbar}>
        <TimeZonePicker
          zone={zone}
          browserZone={browserZone()}
          events={allEvents}
          onChange={setTzRaw}
        />
        <div className={styles.zoomBar} role="group" aria-label="Zoom">
          <button
            type="button"
            className={styles.zoomBtn}
            onClick={() => pxPerHour > MIN_PX_PER_HOUR && zoomButton(-1)}
            aria-disabled={pxPerHour <= MIN_PX_PER_HOUR}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className={styles.zoomBtn}
            onClick={() => pxPerHour < MAX_PX_PER_HOUR && zoomButton(1)}
            aria-disabled={pxPerHour >= MAX_PX_PER_HOUR}
            aria-label="Zoom in"
          >
            +
          </button>
          <button type="button" className={styles.zoomBtn} onClick={fitTrip} disabled={!range}>
            Fit trip
          </button>
        </div>
        <div className={styles.zoomBar} role="group" aria-label="Lanes">
          {LANE_MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`${styles.zoomBtn} ${laneMode === m ? styles.modeOn : ''}`}
              aria-pressed={laneMode === m}
              data-testid={`lanes-${m}`}
              onClick={() => setLaneMode(m)}
            >
              {LANE_MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`${styles.zoomBtn} ${wxOn ? styles.modeOn : ''}`}
          aria-pressed={wxOn}
          data-testid="wx-toggle"
          onClick={() => setWxOn(!wxOn)}
        >
          Weather
        </button>
        <button
          type="button"
          className={styles.today}
          onClick={() => scrollToMs(todayTarget)}
          disabled={!range}
        >
          Today
        </button>
        {wxOn && <WeatherLegend />}
      </div>
      {
        <TimeScaleProvider value={scale}>
          <VisibleRangeProvider value={visible}>
            <div
              className={styles.scroller}
              ref={scroller}
              onScroll={measure}
              data-testid="timeline-scroller"
            >
              {empty && (
                <div className={styles.headingWrap}>
                  <p className={styles.empty} role="status">
                    {totalEvents === 0 ? 'No events yet.' : 'No events match the filters.'}
                  </p>
                </div>
              )}
              {empty && <div style={{ height: lastHeight.current + HEADING_PX }} />}
              {range && (
                <>
                  <div className={styles.headingWrap}>
                    <div className={styles.heading} style={{ height: HEADING_PX }}>
                      {dayHeading(headingMs, zone)}
                    </div>
                  </div>
                  <div
                    className={`${styles.canvas} ${gutter ? styles.withGutter : ''}`}
                    style={
                      {
                        marginTop: HEADING_PX,
                        ['--lanes' as string]: Math.max(1, layout.lanes.length),
                        ['--top-px' as string]: `${topPx}px`,
                        ['--gutter-w' as string]: `${gutterPx}px`,
                      } as React.CSSProperties
                    }
                    data-lane-mode={laneMode}
                  >
                    {laneMode !== 'none' && (
                      <div
                        className={styles.laneHeads}
                        style={{ height: LANE_HEAD_PX, top: HEADING_PX }}
                        data-testid="lane-heads"
                      >
                        {gutter && <div className={styles.headSpacer} />}
                        <div className={styles.headSpacer} />
                        <div className={styles.laneHeadRow}>
                          {layout.lanes.map((l) => (
                            <div
                              key={l.key}
                              className={styles.laneHead}
                              data-testid="lane-head"
                              data-lane={l.key}
                              title={l.label}
                            >
                              {laneMode === 'type' && <EventIcon type={l.key as EventType} />}
                              <span className={styles.laneName}>{l.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className={styles.body} style={{ height }}>
                      {gutter && (
                        <div className={styles.gutter} data-slot="timeline-gutter">
                          {gutter}
                        </div>
                      )}
                      <div className={styles.tickLayer} aria-hidden="true">
                        <Ticks list={tickList} scale={scale} />
                      </div>
                      <div className={styles.axis} aria-hidden="true">
                        <TickLabels list={tickList} scale={scale} />
                      </div>
                      <div className={styles.lanes}>
                        {layout.lanes.map((l) => (
                          <div
                            key={l.key}
                            className={styles.lane}
                            data-testid="lane"
                            data-lane={l.key}
                          >
                            {compact ? (
                              <Chips
                                buckets={bucketsByLane.get(l.key) ?? NO_BUCKETS}
                                byId={byId}
                                zone={zone}
                                onOpen={setOpenId}
                              />
                            ) : (
                              <Blocks
                                blocks={blocksByLane.get(l.key) ?? NO_BLOCKS}
                                byId={byId}
                                onOpen={setOpenId}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                      {showNow && (
                        <div
                          className={styles.now}
                          data-testid="now-line"
                          style={{ top: scale.toY(nowMs) }}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  </div>
                </>
              )}
              {layout.unscheduled.length > 0 && (
                <section className={styles.unscheduled} aria-label="Unscheduled">
                  <h2>Unscheduled</h2>
                  <ul>
                    {layout.unscheduled.map((e) => (
                      <li key={e.id}>
                        <button
                          type="button"
                          className={`${styles.unscheduledItem} ${e.status === 'cancelled' ? styles.cancelled : ''}`}
                          data-testid="unscheduled-item"
                          onClick={() => setOpenId(e.id)}
                        >
                          <EventIcon event={e} /> {e.name}
                          {e.needsReview && (
                            <span className={styles.review} role="img" aria-label="Needs review">
                              !
                            </span>
                          )}
                          {e.status === 'cancelled' && (
                            <span className={styles.srOnly}> (cancelled)</span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </VisibleRangeProvider>
        </TimeScaleProvider>
      }
    </section>
  );
}
