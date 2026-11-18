// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Event } from '@planfully/shared';
import {
  chooseFont,
  coverageFor,
  detectScripts,
  maskRtl,
  sanitize,
  type FontChoice,
} from './fonts';
import { buildItinerary, renderPdf } from './pdf';

describe('detectScripts', () => {
  it.each([
    ['plain ASCII', 'Hotel Le Marais, 12 rue', []],
    ['Latin-1 and WinAnsi punctuation', 'Café – “Zürich” € 5…', []],
    ['Latin extended', 'Łódź Český Krumlov', ['latin-ext']],
    ['Cyrillic', 'Москва', ['latin-ext']],
    ['Greek', 'Αθήνα', ['latin-ext']],
    ['Japanese kana and kanji', 'ホテル 東京', ['kana', 'han']],
    ['Chinese', '北京饭店', ['han']],
    ['Korean', '서울 한국어', ['hangul']],
    ['Korean jamo', 'ㅋㅋ', ['hangul']],
    ['halfwidth Hangul', '\uFFA1\uFFC2', ['hangul']],
    ['fullwidth punctuation', '１２３、', ['han']],
    ['Thai', 'กรุงเทพ', ['thai']],
    ['Arabic', 'القاهرة', ['rtl']],
    ['Hebrew', 'תל אביב', ['rtl']],
    ['emoji', '✈️ 🏨', ['unsupported']],
    ['mixed', 'Tokyo 東京 Москва', ['han', 'latin-ext']],
    ['mixed JP/KR', 'ホテル 서울', ['kana', 'hangul']],
  ])('%s', (_n, text, expected) => {
    expect([...detectScripts(text)].sort()).toEqual([...expected].sort());
  });
});

describe('chooseFont', () => {
  it('returns null when the built-in font is enough', () => {
    expect(chooseFont(new Set())).toBeNull();
  });
  it('picks per script, CJK first', () => {
    expect(chooseFont(new Set(['latin-ext']))?.family).toBe('NotoSans');
    expect(chooseFont(new Set(['thai']))?.family).toBe('NotoSansThai');
    expect(chooseFont(new Set(['kana', 'han', 'thai']))?.family).toBe('NotoSansJP');
    expect(chooseFont(new Set(['han', 'thai']))?.family).toBe('NotoSansSC');
    expect(chooseFont(new Set(['unsupported']))?.family).toBe('NotoSans');
  });
  it('uses the Japanese font for Han-only text when the document has kana', () => {
    expect(chooseFont(new Set(['han']), true)?.family).toBe('NotoSansJP');
    expect(chooseFont(new Set(['han']), false)?.family).toBe('NotoSansSC');
  });
  it('picks the Korean font for Hangul, and kana still wins', () => {
    expect(chooseFont(new Set(['hangul']))?.family).toBe('NotoSansKR');
    expect(chooseFont(new Set(['hangul', 'han', 'latin-ext']))?.family).toBe('NotoSansKR');
    expect(chooseFont(new Set(['kana', 'hangul']))?.family).toBe('NotoSansJP');
  });
  it('needs no font for Arabic/Hebrew alone (they are masked first)', () => {
    expect(chooseFont(new Set(['rtl']))).toBeNull();
  });
});

describe('maskRtl', () => {
  it('leaves other text alone', () => {
    expect(maskRtl('Hotel 東京 서울')).toEqual({ text: 'Hotel 東京 서울', found: [] });
  });
  it('replaces a run with one placeholder, keeping surrounding text', () => {
    expect(maskRtl('Cairo القاهرة Hotel')).toEqual({
      text: 'Cairo [Arabic text] Hotel',
      found: ['Arabic'],
    });
    expect(maskRtl('תל אביב, Israel')).toEqual({
      text: '[Hebrew text], Israel',
      found: ['Hebrew'],
    });
  });
  it("masks Syriac, Thaana and N'Ko too", () => {
    expect(maskRtl('ܐܒܓ')).toEqual({ text: '[Syriac text]', found: ['Syriac'] });
    expect(maskRtl('ހށނ x').text).toBe('[Thaana text] x');
    expect(maskRtl('ߊߋߌ').found).toEqual(["N'Ko"]);
  });
  it('reports both scripts', () => {
    expect(maskRtl('שלום مرحبا').found).toEqual(['Arabic', 'Hebrew']);
  });
  it('keeps newlines', () => {
    expect(maskRtl('שלום\nnotes').text).toBe('[Hebrew text]\nnotes');
  });
});

describe('sanitize', () => {
  it('replaces what the chosen font cannot draw', async () => {
    const noto = await coverageFor(chooseFont(new Set(['latin-ext'])) as FontChoice);
    expect(sanitize('Москва 東京 القاهرة', noto)).toBe('Москва ?? ???????');
    const kr = await coverageFor(chooseFont(new Set(['hangul'])) as FontChoice);
    expect(sanitize('서울 한국어 Seoul', kr)).toBe('서울 한국어 Seoul');
    expect(sanitize('Москва', null)).toBe('??????');
  });
  it('uses real glyph coverage, not script ranges', async () => {
    const jp = await coverageFor(chooseFont(new Set(['han'])) as FontChoice);
    expect(sanitize('東京 ホテル 北京饭店', jp)).toBe('東京 ホテル 北京饭店');
    expect(sanitize('\u{20000}', jp)).toBe('?');
  });
});

const FONT_DIR = new URL('../../public/fonts/', import.meta.url);
const loadReal = async (file: string) => readFileSync(new URL(file, FONT_DIR)).toString('base64');
const event = (name: string, notes = ''): Event => ({
  id: name,
  name,
  type: 'activity',
  attachments: [],
  participants: [],
  status: 'confirmed',
  source: 'manual',
  createdAt: '2026-01-01T00:00:00Z',
  notes,
  start: { local: '2026-07-14T09:00', tz: 'Europe/Paris' },
});
const NO_FILTER = { q: '', types: [], who: [], cancelled: false };

describe('renderPdf font loading', () => {
  it('does not request a font for Latin text', async () => {
    const loadFont = vi.fn(loadReal);
    const save = vi.fn();
    const it = buildItinerary([event('Louvre', 'Café')], [], NO_FILTER, { tripName: 'Paris' });
    await renderPdf(it, { loadFont, save });
    expect(loadFont).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledOnce();
  });

  it('requests the CJK font once when needed, and embeds it', async () => {
    const loadFont = vi.fn(loadReal);
    let pdf = '';
    const it = buildItinerary([event('東京タワー'), event('Красная площадь')], [], NO_FILTER, {
      tripName: 'Trip',
    });
    await renderPdf(it, {
      loadFont,
      save: (doc) => {
        pdf = doc.output();
      },
    });
    // the Cyrillic cell gets Noto Sans: fonts are chosen per cell
    expect(loadFont.mock.calls.map((c) => c[0]).sort()).toEqual([
      'NotoSans-Bold.ttf',
      'NotoSans-Regular.ttf',
      'NotoSansJP-Regular.ttf',
    ]);
    expect(pdf).toContain('NotoSansJP');
  });

  it('uses the Japanese font for kanji-only cells in a Japanese itinerary', async () => {
    const loadFont = vi.fn(loadReal);
    const it = buildItinerary([event('東京'), event('駅前の辻')], [], NO_FILTER, {
      tripName: 'Trip',
    });
    await renderPdf(it, { loadFont, save: () => undefined });
    expect(loadFont.mock.calls.map((c) => c[0])).toEqual(['NotoSansJP-Regular.ttf']);
  });

  it('uses the Simplified Chinese font for Han text without kana', async () => {
    const loadFont = vi.fn(loadReal);
    const it = buildItinerary([event('北京饭店')], [], NO_FILTER, { tripName: 'Trip' });
    await renderPdf(it, { loadFont, save: () => undefined });
    expect(loadFont.mock.calls.map((c) => c[0])).toEqual(['NotoSansSC-Regular.ttf']);
  });

  it('uses the Korean font for Hangul', async () => {
    const loadFont = vi.fn(loadReal);
    const it = buildItinerary([event('서울 호텔')], [], NO_FILTER, { tripName: 'Trip' });
    await renderPdf(it, { loadFont, save: () => undefined });
    expect(loadFont.mock.calls.map((c) => c[0])).toEqual(['NotoSansKR-Regular.ttf']);
  });

  it('draws Latin, Japanese and Korean in one document, each in its own font', async () => {
    const loadFont = vi.fn(loadReal);
    let pdf = '';
    const it = buildItinerary(
      [event('Louvre'), event('東京タワー'), event('서울 호텔')],
      [],
      NO_FILTER,
      { tripName: 'Trip' },
    );
    await renderPdf(it, { loadFont, save: (d) => void (pdf = d.output()) });
    expect(loadFont.mock.calls.map((c) => c[0]).sort()).toEqual([
      'NotoSansJP-Regular.ttf',
      'NotoSansKR-Regular.ttf',
    ]);
    expect(pdf).toContain('NotoSansJP');
    expect(pdf).toContain('NotoSansKR');
    expect(pdf).not.toMatch(/\(\?{2,}\)/);
  });

  it('replaces Arabic/Hebrew with a placeholder, loads no font, and reports it', async () => {
    const loadFont = vi.fn(loadReal);
    let pdf = '';
    const it = buildItinerary([event('Hotel القاهرة'), event('תל אביב')], [], NO_FILTER, {
      tripName: 'Trip',
    });
    const res = await renderPdf(it, { loadFont, save: (d) => void (pdf = d.output()) });
    expect(res.unsupported).toEqual(['Arabic', 'Hebrew']);
    expect(loadFont).not.toHaveBeenCalled();
    expect(pdf).toContain('[Arabic text]');
    expect(pdf).toContain('cannot be shown in this PDF');
  });

  it('requests regular and bold Noto Sans for Cyrillic and Greek', async () => {
    const loadFont = vi.fn(loadReal);
    const it = buildItinerary([event('Αθήνα Москва')], [], NO_FILTER, { tripName: 'Trip' });
    await renderPdf(it, { loadFont, save: () => undefined });
    expect(loadFont.mock.calls.map((c) => c[0])).toEqual([
      'NotoSans-Regular.ttf',
      'NotoSans-Bold.ttf',
    ]);
  });
});
