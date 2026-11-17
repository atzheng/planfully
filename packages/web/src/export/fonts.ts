// Unicode fonts for the PDF export. jsPDF's built-in fonts only cover WinAnsi (Latin), so when the
// itinerary has other characters we fetch a subset Noto font from our own origin (/fonts, SIL OFL,
// see public/fonts/OFL.txt). Detection and font choice are pure; only loadFontBase64 does I/O.

export type Script = 'latin-ext' | 'thai' | 'kana' | 'han' | 'unsupported';

export type FontFace = { style: 'normal' | 'bold'; file: string };
export type FontChoice = { family: string; faces: FontFace[] };

/**
 * Predicate for the glyphs actually present in the choice's font (generated from the font files,
 * see fontCoverage.generated.ts). Imported lazily so the table stays out of the main bundle.
 */
export async function coverageFor(choice: FontChoice): Promise<(cp: number) => boolean> {
  const { FONT_COVERAGE } = await import('./fontCoverage.generated');
  const ranges = FONT_COVERAGE[choice.faces[0]?.file ?? ''] ?? [];
  return (cp) => {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const [a, b] = ranges[mid] as readonly [number, number];
      if (cp < a) hi = mid - 1;
      else if (cp > b) lo = mid + 1;
      else return true;
    }
    return false;
  };
}

/** Same set as jsPDF's built-in WinAnsi coverage (plus tab/newline). */
export function isBuiltinChar(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a) return true;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return true;
  return [0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2026, 0x20ac].includes(cp);
}

const inRanges = (cp: number, ranges: readonly (readonly [number, number])[]) =>
  ranges.some(([a, b]) => cp >= a && cp <= b);

// Mirrors the subsets in scripts/build-pdf-fonts.py.
const LATIN_EXT_RANGES = [
  [0x20, 0x7e],
  [0xa0, 0x24f],
  [0x1e00, 0x1eff],
  [0x2000, 0x206f],
  [0x20a0, 0x20bf],
  [0x2100, 0x214f],
  [0x2190, 0x21ff],
  [0x2200, 0x22ff],
  [0x25a0, 0x25ff],
] as const;
const GREEK_CYR_RANGES = [
  [0x370, 0x3ff],
  [0x1f00, 0x1fff],
  [0x400, 0x52f],
] as const;
const THAI_RANGES = [[0xe00, 0xe7f]] as const;
const KANA_RANGES = [
  [0x3040, 0x30ff],
  [0x31f0, 0x31ff],
] as const;
// Han, CJK punctuation and fullwidth forms. Hangul is deliberately absent: no Korean font yet.
const HAN_RANGES = [
  [0x3000, 0x303f],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0xff00, 0xffef],
] as const;

const coversLatinExt = (cp: number) =>
  inRanges(cp, LATIN_EXT_RANGES) || inRanges(cp, GREEK_CYR_RANGES);

/** Which script a character outside the built-in font belongs to. */
export function classifyChar(cp: number): Script {
  if (coversLatinExt(cp)) return 'latin-ext';
  if (inRanges(cp, THAI_RANGES)) return 'thai';
  if (inRanges(cp, KANA_RANGES)) return 'kana';
  if (inRanges(cp, HAN_RANGES)) return 'han';
  return 'unsupported';
}

/** Scripts present in `text` that the built-in font cannot draw. Empty for plain Latin text. */
export function detectScripts(text: string): Set<Script> {
  const out = new Set<Script>();
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a) continue;
    if (!isBuiltinChar(cp)) out.add(classifyChar(cp));
  }
  return out;
}

const NOTO_SANS: FontChoice = {
  family: 'NotoSans',
  faces: [
    { style: 'normal', file: 'NotoSans-Regular.ttf' },
    { style: 'bold', file: 'NotoSans-Bold.ttf' },
  ],
};
const NOTO_THAI: FontChoice = {
  family: 'NotoSansThai',
  faces: [
    { style: 'normal', file: 'NotoSansThai-Regular.ttf' },
    { style: 'bold', file: 'NotoSansThai-Bold.ttf' },
  ],
};
// CJK fonts have one weight only: bold falls back to the regular file.
const NOTO_JP: FontChoice = {
  family: 'NotoSansJP',
  faces: [
    { style: 'normal', file: 'NotoSansJP-Regular.ttf' },
    { style: 'bold', file: 'NotoSansJP-Regular.ttf' },
  ],
};
const NOTO_SC: FontChoice = {
  family: 'NotoSansSC',
  faces: [
    { style: 'normal', file: 'NotoSansSC-Regular.ttf' },
    { style: 'bold', file: 'NotoSansSC-Regular.ttf' },
  ],
};

/**
 * One font per document (jsPDF has no per-glyph fallback): kana (Japanese font) wins over Han
 * alone (Simplified Chinese font) wins over Thai wins over Latin/Greek/Cyrillic. Characters the chosen font lacks print as '?'. Null: built-in is enough.
 */
export function chooseFont(scripts: ReadonlySet<Script>): FontChoice | null {
  if (scripts.has('kana')) return NOTO_JP;
  if (scripts.has('han')) return NOTO_SC;
  if (scripts.has('thai')) return NOTO_THAI;
  if (scripts.has('latin-ext') || scripts.has('unsupported')) return NOTO_SANS;
  return null;
}

/** Replace characters the target cannot draw with '?'. covers=null means the built-in font. */
export function sanitize(s: string, covers: ((cp: number) => boolean) | null): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a) continue;
    out += isBuiltinChar(cp) || (covers && covers(cp)) ? ch : '?';
  }
  return out;
}

export type FontLoader = (file: string) => Promise<string>;

/** Fetches /fonts/<file> from our own origin and returns it base64-encoded for jsPDF's VFS. */
export const loadFontBase64: FontLoader = async (file) => {
  const res = await fetch(`/fonts/${file}`);
  if (!res.ok) throw new Error(`font ${file}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
};
