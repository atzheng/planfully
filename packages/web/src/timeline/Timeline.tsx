import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Event, RosterMember } from '@planfully/shared';
import { useFilteredEvents } from '../filters/filter';
import { stringCodec, useQueryState } from '../lib/queryState';
import { useTrip } from '../trip/store';
import { layoutEvents, initialScrollMs } from './layout';
import type { Layout } from './layout';
import {
  dayHeading,
  localStartLabel,
  roundRangeToHours,
  timelineRange,
  TYPE_HUE,
  TYPE_ICON,
  validZone,
} from './model';
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
  buttonPx,
  fitPx,
  pinchPx,
  scrollTopForPointer,
  showSecondary,
  useZoom,
  wheelPx,
} from './zoom';
import styles from './Timeline.module.css';

/** Height of the sticky day heading; the canvas starts below it. */
const HEADING_PX = 28;
/** Context kept above the target when scrolling to a time. */
const SCROLL_LEAD_PX = 48;
const NO_ROSTER: readonly RosterMember[] = [];
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const Blocks = memo(function Blocks({
  layout,
  byId,
  onOpen,
}: {
  layout: Layout;
  byId: Map<string, Event>;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      {layout.blocks.map((b) => {
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
              ['--h' as string]: TYPE_HUE[e.type],
            }}
            onClick={() => onOpen(e.id)}
          >
            <span className={styles.blockLabel}>
              <span className={styles.blockIcon} aria-hidden="true">
                {TYPE_ICON[e.type]}
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

const Ticks = memo(function Ticks({ list, scale }: { list: Tick[]; scale: TimeScale }) {
  return (
    <>
      {list.map((t) => (
        <div
          key={t.ms}
          className={`${styles.tick} ${styles[t.kind]}`}
          style={{ top: scale.toY(t.ms) }}
        >
          <span className={styles.tickLabel}>{t.label}</span>
        </div>
      ))}
    </>
  );
});

export function Timeline({ gutter }: { gutter?: ReactNode } = {}) {
  const events = useFilteredEvents();
  const totalEvents = useTrip((s) => s.events.length);
  const roster = useTrip((s) => s.meta?.roster) ?? NO_ROSTER;
  const [tzRaw] = useQueryState('tz', stringCodec, '');
  const [, setOpenId] = useQueryState('e', stringCodec, '');
  const { pxPerHour, setPx } = useZoom();

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
    () => layoutEvents(events, scale, { mode: 'none', roster }),
    [events, scale, roster],
  );
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

  const scrollToMs = useCallback(
    (ms: number, behavior: ScrollBehavior = 'smooth') => {
      scroller.current?.scrollTo({
        top: Math.max(0, scale.toY(ms) + HEADING_PX - SCROLL_LEAD_PX),
        behavior,
      });
    },
    [scale],
  );

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el || !range) return;
    anchorMs.current = anchorMsAt(scale, el.scrollTop, HEADING_PX);
    anchorY.current = 0;
    const topMs = scale.toMs(el.scrollTop - HEADING_PX);
    const botMs = scale.toMs(el.scrollTop + el.clientHeight - HEADING_PX);
    const r = roundRangeToHours(topMs, botMs);
    setVisible((v) => (v.fromMs === r.fromMs && v.toMs === r.toMs ? v : r));
    const h = Math.min(Math.max(topMs, scale.originMs), range?.toMs ?? scale.originMs);
    setHeadingMs(Math.floor(h / 60_000) * 60_000);
  }, [scale, range]);

  // Open at today (or the trip's first day), once, when the axis first exists.
  const scrolled = useRef(false);
  useLayoutEffect(() => {
    if (scrolled.current || !range) return;
    scrolled.current = true;
    scrollToMs(initialScrollMs(events, Date.now()), 'auto');
    anchorMs.current = anchorMsAt(scale, scroller.current?.scrollTop ?? 0, HEADING_PX);
  }, [range, events, scrollToMs, scale]);
  // Keep the time at the top of the viewport at the same screen y when the scale changes (filters, zoom).
  const lastAnchoredScale = useRef(scale);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (range && el && lastAnchoredScale.current !== scale && anchorMs.current !== null) {
      el.scrollTop =
        anchorY.current === 0
          ? scrollTopForAnchor(scale, anchorMs.current, HEADING_PX)
          : scrollTopForPointer(scale, anchorMs.current, HEADING_PX, anchorY.current);
    }
    if (range) lastAnchoredScale.current = scale;
    measure();
  }, [measure, height, scale, range]);
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
      const anchor = ms ?? scaleRef.current.toMs(el.scrollTop + y - HEADING_PX);
      anchorMs.current = anchor;
      anchorY.current = y;
      pxRef.current = px;
      setPx(px);
    },
    [setPx],
  );
  const centreY = () => (scroller.current?.clientHeight ?? 0) / 2;
  const zoomButton = (dir: 1 | -1) => zoomTo(buttonPx(pxRef.current, dir), centreY());
  const fitTrip = () => {
    const r = rangeRef.current;
    const el = scroller.current;
    if (!r || !el) return;
    zoomTo(fitPx(r.fromMs, r.toMs, el.clientHeight - HEADING_PX), HEADING_PX, r.fromMs);
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
          ms: scaleRef.current.toMs(el.scrollTop + midY(ev.touches) - HEADING_PX),
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
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
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
        <span className={styles.zone}>Times in {zone}</span>
        <div className={styles.zoomBar} role="group" aria-label="Zoom">
          <button
            type="button"
            className={styles.zoomBtn}
            onClick={() => zoomButton(-1)}
            disabled={pxPerHour <= MIN_PX_PER_HOUR}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            className={styles.zoomBtn}
            onClick={() => zoomButton(1)}
            disabled={pxPerHour >= MAX_PX_PER_HOUR}
            aria-label="Zoom in"
          >
            +
          </button>
          <button type="button" className={styles.zoomBtn} onClick={fitTrip} disabled={!range}>
            Fit trip
          </button>
        </div>
        <button
          type="button"
          className={styles.today}
          onClick={() => scrollToMs(todayTarget)}
          disabled={!range}
        >
          Today
        </button>
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
                    style={{ height, marginTop: HEADING_PX }}
                  >
                    {gutter && (
                      <div className={styles.gutter} data-slot="timeline-gutter">
                        {gutter}
                      </div>
                    )}
                    <div className={styles.tickLayer} aria-hidden="true">
                      <Ticks list={tickList} scale={scale} />
                    </div>
                    <div className={styles.axis} />
                    <div className={styles.lanes}>
                      <Blocks layout={layout} byId={byId} onOpen={setOpenId} />
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
                          <span aria-hidden="true">{TYPE_ICON[e.type]}</span> {e.name}
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
