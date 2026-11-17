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
import { makeScale, ticks, TimeScaleProvider, VisibleRangeProvider } from './scale';
import type { Tick, TimeScale, VisibleRange } from './scale';
import { usePxPerHour } from './zoom';
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
        return (
          <button
            key={`${b.laneKey}:${b.eventId}`}
            type="button"
            className={`${styles.block} ${cancelled ? styles.cancelled : ''}`}
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
                {time && <span className={styles.blockTime}>{time}</span>}
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
  const pxPerHour = usePxPerHour();

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
      el.scrollTop = scrollTopForAnchor(scale, anchorMs.current, HEADING_PX);
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

  const todayTarget =
    range && nowMs >= range.fromMs && nowMs <= range.toMs ? nowMs : initialScrollMs(events, nowMs);
  const showNow = !!range && nowMs >= range.fromMs && nowMs <= range.toMs;

  const empty = events.length === 0;
  return (
    <section className={styles.timeline} aria-label="Timeline">
      <div className={styles.toolbar}>
        <span className={styles.zone}>Times in {zone}</span>
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
