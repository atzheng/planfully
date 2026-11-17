/**
 * Dependency-free HTML to text for booking emails. Workers have no DOM, so this is a
 * small tag-level converter: it drops non-content elements, keeps table structure
 * (one row per line, cells separated by " | "), and decodes entities.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
  euro: 'EUR',
  pound: 'GBP',
  copy: '(c)',
  middot: '·',
  bull: '•',
  deg: '°',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  ntilde: 'ñ',
  ccedil: 'ç',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
      return code === 0xa0 ? ' ' : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

// Zero-width and soft-hyphen characters used as email preheader padding.
const INVISIBLE_CODES = new Set([0xad, 0x34f, 0x2060, 0xfeff]);
function stripInvisible(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (INVISIBLE_CODES.has(c) || (c >= 0x200b && c <= 0x200f)) continue;
    out += ch;
  }
  return out;
}

/** Input cap: emails can be 25 MB; stay linear and cheap on the Worker. */
export const MAX_HTML_CHARS = 2_000_000;

/** Elements dropped with all their content. */
const SKIP_ELEMENTS = new Set(['head', 'svg', 'noscript', 'template']);
/** Raw-text elements: content is not markup, skip to the closing tag. */
const RAW_TEXT = new Set(['script', 'style']);
/** Elements that may be hidden inline (preheaders, tracking). Not <p>, which is often unclosed. */
const HIDEABLE = new Set(['div', 'span', 'td', 'table', 'tr']);
const BLOCK = new Set([
  'p',
  'div',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'ul',
  'ol',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'section',
  'article',
  'header',
  'footer',
  'blockquote',
  'pre',
  'center',
]);

const ZERO_SIZE_RE = /^0+(\.0+)?(px|em|rem|pt|%|ex|ch|vw|vh)?$/;

/** True when an inline style hides the element: display:none, visibility:hidden or font-size:0. */
export function isHiddenStyle(style: string): boolean {
  for (const decl of style.split(';')) {
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl
      .slice(colon + 1)
      .replace(/!important/i, '')
      .trim()
      .toLowerCase();
    if (prop === 'display' && value === 'none') return true;
    if (prop === 'visibility' && value === 'hidden') return true;
    if (prop === 'font-size' && ZERO_SIZE_RE.test(value)) return true;
  }
  return false;
}

/** Value of the style attribute (double or single quoted) in a raw tag, or ''. */
function styleAttr(tag: string): string {
  const m = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  return m ? (m[1] ?? m[2] ?? '') : '';
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * End index (exclusive) of the tag starting at `start` ('<'), honouring quoted attribute values,
 * or -1 if the tag never closes.
 */
function tagEnd(s: string, start: number): number {
  let quote = '';
  for (let i = start + 1; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i + 1;
  }
  return -1;
}

/** Linear single pass: every input character is visited a constant number of times. */
function render(html: string): string {
  const lower = asciiLower(html);
  const out: string[] = [];
  let skipName = '';
  let skipDepth = 0;
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      if (!skipName) out.push(html.slice(i));
      break;
    }
    if (lt > i && !skipName) out.push(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      if (close < 0) break;
      i = close + 3;
      continue;
    }
    const next = html[lt + 1] ?? '';
    const closing = next === '/';
    const nameStart = lt + (closing ? 2 : 1);
    if (!/[A-Za-z]/.test(html[nameStart] ?? '')) {
      // '<' that does not start a tag (or <! / <?): treat as text unless a declaration.
      if (next === '!' || next === '?') {
        const gt = html.indexOf('>', lt);
        if (gt < 0) break;
        i = gt + 1;
      } else {
        if (!skipName) out.push('<');
        i = lt + 1;
      }
      continue;
    }
    let nameEnd = nameStart;
    while (nameEnd < n && /[A-Za-z0-9]/.test(html[nameEnd] ?? '')) nameEnd++;
    const name = lower.slice(nameStart, nameEnd);
    const end = tagEnd(html, lt);
    if (end < 0) break; // no '>' anywhere after: the rest is a broken tag
    const raw = html.slice(lt, end);
    const selfClosing = raw.endsWith('/>');
    i = end;

    if (skipName) {
      if (name === skipName && !selfClosing) skipDepth += closing ? -1 : 1;
      if (skipDepth <= 0) skipName = '';
      continue;
    }
    if (closing) {
      if (name === 'td' || name === 'th') out.push(' | ');
      else if (name === 'tr') out.push('\n');
      else if (BLOCK.has(name)) out.push('\n');
      continue;
    }
    if (RAW_TEXT.has(name)) {
      if (!selfClosing) {
        const close = lower.indexOf(`</${name}`, i);
        if (close < 0) break;
        const gt = html.indexOf('>', close);
        i = gt < 0 ? n : gt + 1;
      }
      continue;
    }
    if (SKIP_ELEMENTS.has(name) || (HIDEABLE.has(name) && isHiddenStyle(styleAttr(raw)))) {
      if (!selfClosing) {
        skipName = name;
        skipDepth = 1;
      }
      continue;
    }
    if (name === 'br') out.push('\n');
    else if (name === 'hr') out.push('\n---\n');
    else if (name === 'li') out.push('\n- ');
    else if (BLOCK.has(name)) out.push('\n');
  }
  return out.join('');
}

function tidy(text: string): string {
  const lines = text.split('\n').map((line) => {
    let l = line.replace(/[ \t\r\f\v]+/g, ' ').trim();
    // Tidy table rows: drop empty cells and the trailing separator.
    if (l.includes('|')) {
      l = l
        .split('|')
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
        .join(' | ');
    }
    return l;
  });
  // Collapse runs of blank lines to at most one.
  const out: string[] = [];
  for (const l of lines) {
    if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** Renders HTML to text; input beyond MAX_HTML_CHARS is cut and reported via `truncated`. */
export function htmlToTextLimited(html: string): { text: string; truncated: boolean } {
  const truncated = html.length > MAX_HTML_CHARS;
  const src = truncated ? html.slice(0, MAX_HTML_CHARS) : html;
  return { text: tidy(stripInvisible(decodeEntities(render(src)))), truncated };
}

export function htmlToText(html: string): string {
  return htmlToTextLimited(html).text;
}
