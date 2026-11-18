import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '@planfully/shared';
import { TYPE_HUE } from './timeline/model';

const css = readFileSync(join(process.cwd(), 'src/typeColors.css'), 'utf8');
const theme = readFileSync(join(process.cwd(), 'src/theme.css'), 'utf8');

/** Body of the first rule whose selector is exactly `selector`. */
function block(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no rule ${selector}`);
  return source.slice(start, source.indexOf('}', start));
}

function hsl(value: string): { h: number; rgb: [number, number, number] } {
  const m = /hsl\((\d+) (\d+)% (\d+)%\)/.exec(value);
  if (!m) throw new Error(`not hsl: ${value}`);
  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return { h, rgb: [f(0), f(8), f(4)] };
}

function hex(value: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!m?.[1]) throw new Error(`not hex: ${value}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (rgb: [number, number, number]) =>
  0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function token(source: string, name: string): string {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(source);
  if (!m?.[1]) throw new Error(`missing --${name}`);
  return m[1];
}

const themes = {
  light: { rules: block(css, ':root'), surface: '#ffffff' },
  dark: {
    rules: block(css, ":root[data-theme='dark']"),
    surface: token(block(theme, ":root[data-theme='dark']"), 'gray-1'),
  },
};

describe('per-type colour tokens', () => {
  it('has tokens for every event type in both themes, with the TYPE_HUE hue', () => {
    for (const t of EVENT_TYPES) {
      for (const th of Object.values(themes)) {
        for (const part of ['bg', 'fg', 'bar']) {
          expect(hsl(token(th.rules, `type-${t}-${part}`)).h).toBe(TYPE_HUE[t]);
        }
      }
      expect(css).toContain(`[data-type='${t}']`);
    }
  });

  for (const [name, th] of Object.entries(themes)) {
    describe(name, () => {
      for (const t of EVENT_TYPES) {
        it(`${t}: text on tint >= 4.5:1, accent bar vs tint and surface >= 3:1`, () => {
          const bg = hsl(token(th.rules, `type-${t}-bg`)).rgb;
          const fg = hsl(token(th.rules, `type-${t}-fg`)).rgb;
          const bar = hsl(token(th.rules, `type-${t}-bar`)).rgb;
          expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(bar, bg)).toBeGreaterThanOrEqual(3);
          expect(contrast(bar, hex(th.surface))).toBeGreaterThanOrEqual(3);
        });
      }
    });
  }

  it('text and accent pairs of the base theme meet AA', () => {
    for (const rules of [block(theme, ':root'), block(theme, ":root[data-theme='dark']")]) {
      const get = (n: string) => hex(token(rules, n));
      expect(contrast(get('accent-text'), get('accent'))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
