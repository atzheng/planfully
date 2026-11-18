import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Event, EventType, RosterMember } from '@planfully/shared';
import { useFilteredEvents, useWhoSelection } from '../filters/filter';
import { booleanCodec, stringCodec, useQueryState } from '../lib/queryState';
import { useRegisterCentre } from '../event/AddEvent';
import { useTrip } from '../trip/store';
import { EventIcon } from '../ui/EventIcon';
import {
  blockTier,
  initialScrollMs,
  layoutEvents,
  maxColumnsForWidth,
  RAIL_PX,
  RAIL_STEP_PX,
  MAX_RAILS,
  blockGeometry,
  withoutEmptyLanes,
} from './layout';
import type { Layout } from './layout';
import { laneModeCodec } from './lanes';
import { useRegisterFit, useTimelineControls } from './controls';
import { roundRangeToHours, timelineRange, validZone } from './model';
import { axisHourLabel, dayHeadingParts, localTimeRange, placeLabel, prefers12h } from './labels';
import { Badge } from '../ui/Badge';
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
  SECONDARY_TEXT_MIN_PX,
  useZoom,
  wheelPx,
} from './zoom';
import { ChevronDown, ChevronUp, Minus, Plus } from 'lucide-react';
import { TimeZonePicker } from './TimeZonePicker';
import { WEATHER_GUTTER_PX, WeatherLegend, WeatherStrip } from './WeatherStrip';
import styles from './Timeline.module.css';

/** Height of the sticky day heading; the canvas starts below it. */
const HEADING_PX = 24;
/** Height of the sticky lane header row (only present in a lane mode). */
const LANE_HEAD_PX = 24;
/** Width of the hour axis column (matches --axis-w in Timeline.module.css). */
const AXIS_PX = 44;
/** Context kept above the target when scrolling to a time. */
const SCROLL_LEAD_PX = 48;
/** Block height at which the place line joins the title and time. */
const PLACE_MIN_PX = 60;
/** Minimum lane width (matches --lane-min in Timeline.module.css). */
const LANE_MIN_PX = 140;
/** Rail height from which the vertical name label is shown. */
const RAIL_LABEL_MIN_PX = 48;
const NO_ROSTER: readonly RosterMember[] = [];
const NO_BLOCKS: Layout['blocks'] = [];
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const Blocks = memo(function Blocks({
  blocks,
  byId,
  selectedId,
  laneWidth,
  onOpen,
}: {
  blocks: Layout['blocks'];
  byId: Map<string, Event>;
  selectedId: string;
  laneWidth: number;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      {blocks.map((b) => {
        const e = byId.get(b.eventId);
        if (!e) return null;
        const time = localTimeRange(e);
        const place = placeLabel(e);
        const cancelled = e.status === 'cancelled';
        const tier = blockTier(b.height, SECONDARY_TEXT_MIN_PX);
        const secondary = tier === 'full';
        const bar = tier === 'bar';
        const selected = e.id === selectedId;
        if (b.rail) {
          const name = `${e.name}${time ? `, ${time}` : ''}${cancelled ? ' (cancelled)' : ''}${e.needsReview ? ' (needs review)' : ''}`;
          return (
            <button
              key={`${b.laneKey}:${b.eventId}`}
              type="button"
              className={`${styles.rail} ${cancelled ? styles.cancelled : ''} ${selected ? styles.selected : ''}`}
              aria-current={selected ? 'true' : undefined}
              data-testid="block"
              data-rail="true"
              data-event-id={e.id}
              data-type={e.type}
              title={name}
              aria-label={name}
              style={{
                top: b.top,
                height: b.height,
                right: b.railSlot * RAIL_STEP_PX,
                zIndex: 1 + MAX_RAILS - b.railSlot,
                width: RAIL_PX,
              }}
              onClick={() => onOpen(e.id)}
            >
              <span className={styles.railFace}>
                {b.height >= RAIL_LABEL_MIN_PX && (
                  <span className={styles.railLabel} aria-hidden="true">
                    <EventIcon event={e} size={12} />
                    <span className={styles.railName}>{e.name}</span>
                  </span>
                )}
              </span>
            </button>
          );
        }
        const geo = blockGeometry(b, laneWidth);
        return (
          <button
            key={`${b.laneKey}:${b.eventId}`}
            type="button"
            className={`${styles.block} ${cancelled ? styles.cancelled : ''} ${tier === 'full' ? '' : bar ? styles.bar : styles.compact} ${selected ? styles.selected : ''}`}
            aria-current={selected ? 'true' : undefined}
            data-testid="block"
            data-event-id={e.id}
            data-type={e.type}
            data-tier={tier}
            title={bar ? e.name : undefined}
            aria-label={
              bar
                ? `${e.name}${time ? `, ${time}` : ''}${cancelled ? ' (cancelled)' : ''}${e.needsReview ? ' (needs review)' : ''}`
                : undefined
            }
            style={{
              top: b.top,
              height: b.height,
              left: geo.left,
              width: geo.width,
            }}
            onClick={() => onOpen(e.id)}
          >
            {bar ? null : (
              <span className={styles.blockLabel}>
                <span className={styles.blockIcon} aria-hidden="true">
                  <EventIcon event={e} />
                </span>
                <span className={styles.blockText}>
                  <span className={styles.blockName}>{e.name}</span>
                  {time && secondary && <span className={styles.blockTime}>{time}</span>}
                  {place && b.height >= PLACE_MIN_PX && (
                    <span className={styles.blockPlace}>{place}</span>
                  )}
                  {cancelled && <span className={styles.srOnly}> (cancelled)</span>}
                </span>
              </span>
            )}
            {e.needsReview && !bar && (
              <Badge
                tone="warning"
                className={styles.review}
                title="Needs review"
                role="img"
                aria-label="Needs review"
              >
                !
              </Badge>
            )}
          </button>
        );
      })}
    </>
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

const TickLabels = memo(function TickLabels({
  list,
  scale,
  zone,
  endMs,
}: {
  list: Tick[];
  scale: TimeScale;
  zone: string;
  /** The axis end: a tick there has no room below it (it would run into the Unscheduled list). */
  endMs: number;
}) {
  const hour12 = useMemo(() => prefers12h(), []);
  return (
    <>
      {list.map((t) => {
        if (t.ms >= endMs) return null;
        const parts = t.kind === 'day' ? dayHeadingParts(t.ms, zone) : null;
        return (
          <span
            key={t.ms}
            className={`${styles.tickLabel} ${styles[t.kind]}`}
            style={{ top: scale.toY(t.ms) + 2 }}
          >
            {parts ? (
              <>
                <b>{parts.weekday}</b>
                <span className={styles.nowrap}>{parts.rest}</span>
              </>
            ) : t.kind === 'hour' ? (
              axisHourLabel(t.ms, zone, hour12)
            ) : (
              t.label
            )}
          </span>
        );
      })}
    </>
  );
});

export function Timeline({ gutter: gutterProp }: { gutter?: ReactNode } = {}) {
  const events = useFilteredEvents();
  const totalEvents = useTrip((s) => s.events.length);
  const roster = useTrip((s) => s.meta?.roster) ?? NO_ROSTER;
  const allEvents = useTrip((s) => s.events);
  const [tzRaw, setTzRaw] = useQueryState('tz', stringCodec, '');
  const [openId, setOpenId] = useQueryState('e', stringCodec, '');
  const { include: who, exclude: whoOut } = useWhoSelection();
  const [laneMode] = useQueryState('lanes', laneModeCodec, 'none');
  const [wxOn] = useQueryState('wx', booleanCodec, false);
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
  // Lane width drives the column cap. Lane count is estimated before layout (lanes depend on it).
  const [viewW, setViewW] = useState(375);
  const laneCount =
    laneMode === 'none'
      ? 1
      : laneMode === 'type'
        ? new Set(events.map((e) => e.type)).size
        : who.length || roster.length;
  const laneWidth = Math.max(
    LANE_MIN_PX,
    (viewW - (wxOn || gutterProp ? gutterPx : 0) - AXIS_PX) / Math.max(1, laneCount),
  );
  const layout = useMemo(
    () =>
      withoutEmptyLanes(
        layoutEvents(
          events,
          scale,
          { mode: laneMode, roster, only: who, exclude: whoOut },
          maxColumnsForWidth(laneWidth),
          laneWidth,
        ),
        laneMode,
      ),
    [laneWidth, events, scale, roster, laneMode, who, whoOut],
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
    const ro = new ResizeObserver(() => {
      measure();
      setViewW(el.clientWidth);
    });
    ro.observe(el);
    setViewW(el.clientWidth);
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

  useRegisterFit(range ? fitTrip : null);
  const tzControls = useTimelineControls();
  const todayOff = !!range && (todayTarget < visible.fromMs || todayTarget > visible.toMs);

  const empty = events.length === 0;
  const headingParts = dayHeadingParts(headingMs, zone);
  /** The tz label sits in the axis column's corner, to the right of any gutter. */
  const cornerLeft = gutter ? gutterPx : 0;
  return (
    <section className={styles.timeline} aria-label="Timeline">
      {
        <TimeScaleProvider value={scale}>
          <VisibleRangeProvider value={visible}>
            <div
              className={styles.scroller}
              ref={scroller}
              onScroll={measure}
              tabIndex={0}
              aria-label="Timeline canvas. Plus and minus zoom."
              onKeyDown={(ev) => {
                if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.target !== ev.currentTarget) return;
                if (ev.key === '+' || ev.key === '=') zoomButton(1);
                else if (ev.key === '-') zoomButton(-1);
              }}
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
                    <div
                      className={styles.heading}
                      style={{ height: HEADING_PX, paddingLeft: cornerLeft + AXIS_PX + 8 }}
                    >
                      <b>{headingParts.weekday}</b>
                      <span>{headingParts.rest}</span>
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
                              {laneMode === 'type' && (
                                <EventIcon type={l.key as EventType} size={14} />
                              )}
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
                        <TickLabels list={tickList} scale={scale} zone={zone} endMs={range.toMs} />
                        {showNow && (
                          <div className={styles.nowTick} style={{ top: scale.toY(nowMs) }} />
                        )}
                      </div>
                      <div className={styles.lanes}>
                        {layout.lanes.map((l) => (
                          <div
                            key={l.key}
                            className={styles.lane}
                            data-testid="lane"
                            data-lane={l.key}
                          >
                            <Blocks
                              blocks={blocksByLane.get(l.key) ?? NO_BLOCKS}
                              byId={byId}
                              selectedId={openId}
                              laneWidth={laneWidth}
                              onOpen={setOpenId}
                            />
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
                          <EventIcon event={e} />
                          <span className={styles.unscheduledName}>{e.name}</span>
                          {e.needsReview && (
                            <Badge tone="warning" role="img" aria-label="Needs review">
                              !
                            </Badge>
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
      <div
        className={styles.tzCorner}
        style={{ left: cornerLeft, width: AXIS_PX, height: HEADING_PX }}
      >
        <TimeZonePicker
          compact
          zone={zone}
          browserZone={browserZone()}
          events={allEvents}
          onChange={setTzRaw}
          open={tzControls?.tzOpen}
          onOpenChange={tzControls?.setTzOpen}
        />
      </div>
      {wxOn && (
        <div className={styles.legend}>
          <WeatherLegend />
        </div>
      )}
      {todayOff && (
        <button
          type="button"
          className={styles.todayPill}
          style={{ top: topPx + 8 }}
          data-testid="today-pill"
          onClick={() => scrollToMs(todayTarget)}
        >
          {todayTarget < visible.fromMs ? (
            <ChevronUp size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          )}
          Today
        </button>
      )}
      <div className={styles.zoomPair} role="group" aria-label="Zoom">
        <button
          type="button"
          className={styles.zoomBtn}
          onClick={() => pxPerHour < MAX_PX_PER_HOUR && zoomButton(1)}
          aria-disabled={pxPerHour >= MAX_PX_PER_HOUR}
          aria-label="Zoom in"
        >
          <Plus size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.zoomBtn}
          onClick={() => pxPerHour > MIN_PX_PER_HOUR && zoomButton(-1)}
          aria-disabled={pxPerHour <= MIN_PX_PER_HOUR}
          aria-label="Zoom out"
        >
          <Minus size={18} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
