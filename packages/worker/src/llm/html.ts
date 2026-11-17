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

export function htmlToText(html: string): string {
  let s = html;
  // Non-content elements, with their bodies.
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|head|svg|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  // Elements hidden inline (preheaders, tracking).
  s = s.replace(
    /<(div|span|p|td)\b[^>]*style\s*=\s*"[^"]*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0)[^"]*"[^>]*>[\s\S]*?<\/\1\s*>/gi,
    '',
  );
  // Images, including 1x1 trackers, carry no text.
  s = s.replace(/<img\b[^>]*>/gi, '');
  // Structure.
  s = s.replace(/<br\b[^>]*>/gi, '\n');
  s = s.replace(/<hr\b[^>]*>/gi, '\n---\n');
  s = s.replace(/<\/t[dh]\s*>/gi, ' | ');
  s = s.replace(/<\/tr\s*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(
    /<\/?(p|div|table|thead|tbody|tfoot|ul|ol|h[1-6]|section|article|header|footer|blockquote|pre|center)\b[^>]*>/gi,
    '\n',
  );
  // Remaining tags.
  s = s.replace(/<[^>]+>/g, '');
  s = stripInvisible(decodeEntities(s));

  const lines = s.split('\n').map((line) => {
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
