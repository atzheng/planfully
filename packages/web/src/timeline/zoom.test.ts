// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { makeScale, MAX_PX_PER_HOUR, MIN_PX_PER_HOUR } from './scale';
import {
  attachGestureZoom,
  buttonPx,
  gesturePx,
  clampPx,
  DEFAULT_ZOOM,
  fitPx,
  pinchPx,
  pxToZoom,
  scrollTopForPointer,
  wheelPx,
  zoomCodec,
  zoomToPx,
} from './zoom';

const H = 3_600_000;

describe('zoom math', () => {
  it('clamps to the range', () => {
    expect(clampPx(1000)).toBe(MAX_PX_PER_HOUR);
    expect(clampPx(0.001)).toBe(MIN_PX_PER_HOUR);
    expect(clampPx(NaN)).toBe(48);
    expect(MAX_PX_PER_HOUR).toBe(120);
    expect(MIN_PX_PER_HOUR).toBe(0.5);
  });
  it('round-trips through the log scale', () => {
    expect(zoomToPx(pxToZoom(48))).toBeCloseTo(48, 1);
    expect(pxToZoom(1)).toBe(0);
    expect(zoomToPx(DEFAULT_ZOOM)).toBeCloseTo(48, 1);
  });
  it('codec clamps and rejects junk', () => {
    expect(zoomCodec.parse('abc')).toBeUndefined();
    expect(zoomCodec.parse('99')).toBe(pxToZoom(MAX_PX_PER_HOUR));
    expect(zoomCodec.parse('-99')).toBe(pxToZoom(MIN_PX_PER_HOUR));
    expect(zoomCodec.serialize(3)).toBe('3');
  });
  it('buttons step evenly and stop at the limits', () => {
    expect(buttonPx(buttonPx(10, 1), -1)).toBeCloseTo(10);
    expect(buttonPx(MAX_PX_PER_HOUR, 1)).toBe(MAX_PX_PER_HOUR);
    expect(buttonPx(MIN_PX_PER_HOUR, -1)).toBe(MIN_PX_PER_HOUR);
  });
  it('wheel: negative deltaY zooms in, capped per event', () => {
    expect(wheelPx(10, -10)).toBeGreaterThan(10);
    expect(wheelPx(10, 10)).toBeLessThan(10);
    expect(wheelPx(10, -10000)).toBe(wheelPx(10, -60));
    expect(wheelPx(10, 0)).toBe(10);
  });
  it('pinch scales with finger distance', () => {
    expect(pinchPx(10, 100, 200)).toBe(20);
    expect(pinchPx(10, 100, 50)).toBe(5);
    expect(pinchPx(10, 0, 50)).toBe(10);
  });
  it('fit trip', () => {
    expect(fitPx(0, 100 * H, 500)).toBe(5);
    expect(fitPx(0, 0, 500)).toBe(48);
    expect(fitPx(0, 1e6 * H, 500)).toBe(MIN_PX_PER_HOUR);
  });
  it('keeps the anchored time at the same screen y', () => {
    const origin = 1_700_000_000_000;
    const before = makeScale(origin, 48);
    const heading = 28;
    const scrollTop = 900;
    const y = 200;
    const ms = before.toMs(scrollTop + y - heading);
    for (const px of [0.5, 3, 48, 120]) {
      const after = makeScale(origin, px);
      const top = scrollTopForPointer(after, ms, heading, y);
      if (top > 0) expect(after.toMs(top + y - heading)).toBeCloseTo(ms, 0);
    }
  });
});

describe('safari gestures', () => {
  it('scales relative to the start and prevents page zoom', () => {
    const el = document.createElement('div');
    const calls: [number, number][] = [];
    const off = attachGestureZoom(
      el,
      () => 10,
      (px, y) => calls.push([px, y]),
    );
    const fire = (type: string, extra: object) => {
      const ev = new Event(type, { cancelable: true });
      Object.assign(ev, extra);
      el.dispatchEvent(ev);
      return ev;
    };
    expect(fire('gesturestart', { scale: 1 }).defaultPrevented).toBe(true);
    const ev = fire('gesturechange', { scale: 2, clientY: 120 });
    expect(ev.defaultPrevented).toBe(true);
    expect(calls).toEqual([[20, 120]]);
    expect(gesturePx(10, 0)).toBe(10);
    off();
    fire('gesturechange', { scale: 3, clientY: 1 });
    expect(calls).toHaveLength(1);
  });
});
