import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { stringCodec, useQueryState } from '../lib/queryState';
import { useWeather } from '../weather/useWeather';
import { defaultUnits } from '../weather/units';
import { validZone } from './model';
import { useTimeScale, useVisibleRange } from './scale';
import {
  buildStrip,
  describeHit,
  fetchRange,
  hitAt,
  scaleMax,
  stepFor,
  type Bucket,
  type Hit,
  type StripSegment,
} from './weatherAgg';
import styles from './WeatherStrip.module.css';

/** Width of the gutter column when the weather strip is shown (the plain gutter is 64px). */
export const WEATHER_GUTTER_PX = 96;
const PAD = 4;
/** Horizontal tracks inside the strip: temperature, wind, rain. */
const TEMP = { x: 0, w: 44 };
const WIND = { x: 46, w: 22 };
const RAIN = { x: 70, w: 26 };
const MIN_DAY_LABEL_PX = 34;
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

type Tip = { text: string; x: number; y: number; ms: number };

function pathOf(
  buckets: readonly Bucket[],
  x: (b: Bucket) => number,
  y: (ms: number) => number,
): string {
  let d = '';
  let prevEnd = NaN;
  for (const b of buckets) {
    const cmd = b.fromMs === prevEnd ? 'L' : 'M';
    d += `${cmd}${x(b).toFixed(1)} ${y((b.fromMs + b.toMs) / 2).toFixed(1)}`;
    prevEnd = b.toMs;
  }
  return d;
}

export function WeatherStrip() {
  const scale = useTimeScale();
  const visible = useVisibleRange();
  const [tzRaw] = useQueryState('tz', stringCodec, '');
  const zone = useMemo(() => validZone(tzRaw, browserZone()), [tzRaw]);
  const units = useMemo(() => defaultUnits(), []);
  const range = useMemo(() => fetchRange(visible), [visible]);
  const weather = useWeather(range.fromMs, range.toMs);
  const step = stepFor(scale.pxPerHour);
  const strip = useMemo(() => buildStrip(weather.series, step, zone), [weather.series, step, zone]);
  const [tip, setTip] = useState<Tip | null>(null);

  if (weather.status === 'idle') {
    return (
      <div className={styles.strip} data-testid="weather-strip">
        <p className={styles.idle}>Add a place to see weather</p>
      </div>
    );
  }

  const { extents } = strip;
  const max = scaleMax(extents, step);
  const top = scale.toY(range.fromMs);
  const height = Math.max(1, scale.toY(range.toMs) - top);
  const y = (ms: number) => scale.toY(ms) - top;
  const tSpan = Math.max(1, extents.tempMax - extents.tempMin);
  const tx = (c: number) => TEMP.x + PAD + ((c - extents.tempMin) / tSpan) * (TEMP.w - 2 * PAD);
  const wx = (kph: number) => WIND.x + PAD + (kph / max.wind) * (WIND.w - 2 * PAD);
  const rainW = (mm: number) => (mm <= 0 ? 0 : Math.max(2, (mm / max.rain) * (RAIN.w - PAD)));

  const show = (clientX: number, clientY: number, target: SVGSVGElement) => {
    const r = target.getBoundingClientRect();
    const ms = scale.toMs(clientY - r.top + top);
    const hit: Hit | null = hitAt(strip.segments, ms);
    setTip(hit ? { text: describeHit(hit, step, zone, units), x: clientX, y: clientY, ms } : null);
  };

  let lastLabelY = -Infinity;
  const renderSegment = (s: StripSegment, i: number) => {
    // A place label where the place changes; skipped when the segment is too short or it would collide.
    const segY = y(s.segment.fromMs);
    let placeLabelY: number | null = null;
    if (
      i > 0 &&
      s.segment.label &&
      y(s.segment.toMs) - segY >= 12 &&
      segY + 11 - lastLabelY >= 12
    ) {
      placeLabelY = segY + 11;
      lastLabelY = placeLabelY;
    }
    const key = `${s.segment.fromMs}|${s.segment.lat}|${s.segment.lng}`;
    const showDay = scale.pxPerHour * 24 >= MIN_DAY_LABEL_PX;
    return (
      <g key={key}>
        {s.bands.map((b) => {
          const by = y(b.fromMs);
          const bh = y(b.toMs) - by;
          return (
            <g key={b.fromMs} data-testid={b.kind === 'error' ? 'wx-error' : 'wx-none'}>
              <rect
                x={0}
                y={by}
                width={WEATHER_GUTTER_PX}
                height={bh}
                fill="url(#wx-hatch)"
                className={styles.band}
              />
              {bh >= 16 && (
                <text x={WEATHER_GUTTER_PX / 2} y={by + bh / 2 + 3} className={styles.bandText}>
                  {b.kind === 'error' ? 'unavailable' : 'no forecast'}
                </text>
              )}
            </g>
          );
        })}
        {i > 0 && (
          <line
            x1={0}
            x2={WEATHER_GUTTER_PX}
            y1={y(s.segment.fromMs)}
            y2={y(s.segment.fromMs)}
            className={styles.change}
          />
        )}
        {step === 'day' ? (
          s.buckets.map((b) => {
            const by = y(b.fromMs);
            const bh = y(b.toMs) - by;
            const thick = Math.min(6, Math.max(2, bh - 2));
            const cy = showDay ? by + 18 : by + bh / 2 - thick / 2;
            return (
              <rect
                key={b.fromMs}
                x={tx(b.tempMin)}
                y={cy}
                width={Math.max(3, tx(b.tempMax) - tx(b.tempMin))}
                height={thick}
                rx={3}
                className={styles.tempBar}
              />
            );
          })
        ) : (
          <path d={pathOf(s.buckets, (b) => tx(b.tempAvg), y)} className={styles.tempLine} />
        )}
        <path
          d={pathOf(s.buckets, (b) => wx(step === 'day' ? b.windMax : b.windAvg), y)}
          className={styles.windLine}
        />
        {s.buckets.map((b) => {
          const w = rainW(b.precipSum);
          if (w === 0) return null;
          const by = y(b.fromMs);
          return (
            <rect
              key={b.fromMs}
              x={RAIN.x + PAD}
              y={by + 1}
              width={w}
              height={Math.max(1, y(b.toMs) - by - 2)}
              rx={2}
              className={styles.rain}
            />
          );
        })}
        {showDay &&
          s.days.map((d) => (
            <text
              key={`d${d.fromMs}`}
              x={TEMP.x + PAD}
              y={y(d.fromMs) + 11}
              className={styles.dayLabel}
              data-testid="wx-day"
            >
              {`${Math.round(units.temp === 'F' ? (d.tempMin * 9) / 5 + 32 : d.tempMin)}/${Math.round(units.temp === 'F' ? (d.tempMax * 9) / 5 + 32 : d.tempMax)}°`}
            </text>
          ))}
        {placeLabelY !== null && (
          <text x={3} y={placeLabelY} className={styles.place} data-testid="wx-place">
            {s.segment.label.length > 14 ? `${s.segment.label.slice(0, 13)}…` : s.segment.label}
          </text>
        )}
      </g>
    );
  };

  return (
    <div
      className={styles.strip}
      data-testid="weather-strip"
      data-step={step}
      data-status={weather.status}
    >
      <svg
        className={styles.svg}
        style={{ top, height }}
        width={WEATHER_GUTTER_PX}
        height={height}
        role="img"
        aria-label="Weather: temperature, wind and rain. Tap a time for values."
        onPointerMove={(e) =>
          e.pointerType === 'mouse' && show(e.clientX, e.clientY, e.currentTarget)
        }
        onPointerLeave={(e) => e.pointerType === 'mouse' && setTip(null)}
        onClick={(e) => show(e.clientX, e.clientY, e.currentTarget)}
      >
        <defs>
          <pattern
            id="wx-hatch"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="6" className={styles.hatch} />
          </pattern>
        </defs>
        {strip.segments.map(renderSegment)}
        {tip && (
          <line
            x1={0}
            x2={WEATHER_GUTTER_PX}
            y1={y(tip.ms)}
            y2={y(tip.ms)}
            className={styles.cursor}
          />
        )}
      </svg>
      {tip &&
        createPortal(
          <div
            className={styles.tip}
            role="status"
            data-testid="wx-tip"
            style={{ left: Math.min(tip.x + 12, window.innerWidth - 8), top: tip.y }}
          >
            {tip.text}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Legend for the weather toolbar: marks differ in shape as well as colour. */
export function WeatherLegend() {
  const units = useMemo(() => defaultUnits(), []);
  return (
    <ul className={styles.legend} aria-label="Weather key" data-testid="wx-legend">
      <li>
        <svg width="22" height="10" aria-hidden="true">
          <path d="M2 8 L8 2 L14 6 L20 2" className={styles.tempLine} />
        </svg>
        Temp °{units.temp}
      </li>
      <li>
        <svg width="22" height="10" aria-hidden="true">
          <path d="M2 5 L20 5" className={styles.windLine} />
        </svg>
        Wind {units.wind === 'mph' ? 'mph' : 'km/h'}
      </li>
      <li>
        <svg width="22" height="10" aria-hidden="true">
          <rect x="2" y="1" width="14" height="8" rx="2" className={styles.rain} />
        </svg>
        Rain
      </li>
    </ul>
  );
}
