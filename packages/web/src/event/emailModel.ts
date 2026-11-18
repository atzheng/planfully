// Pure helpers for the in-app email viewer (planfully-qnr). No React, no postal-mime import:
// the parsed shape is declared structurally so this module stays out of the main bundle.

/** Subset of postal-mime's parsed result that the viewer uses. */
export type ParsedAddress = { name?: string; address?: string };
export type ParsedAttachment = {
  filename: string | null;
  mimeType: string;
  disposition: 'attachment' | 'inline' | null;
  related?: boolean;
  contentId?: string;
  content: ArrayBuffer | Uint8Array | string;
};
export type ParsedEmail = {
  from?: ParsedAddress;
  to?: ParsedAddress[];
  cc?: ParsedAddress[];
  date?: string;
  subject?: string;
  html?: string;
  text?: string;
  attachments: ParsedAttachment[];
};

/** Never include allow-scripts or allow-same-origin: the email is untrusted and must stay inert. */
export const EMAIL_IFRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

export { isEmailAttachment } from './format';

export function formatAddress(a: ParsedAddress | undefined): string {
  if (!a) return '';
  if (a.name && a.address) return `${a.name} <${a.address}>`;
  return a.address ?? a.name ?? '';
}

export function formatAddresses(list: ParsedAddress[] | undefined): string {
  return (list ?? []).map(formatAddress).filter(Boolean).join(', ');
}

export type EmailHeaders = { from: string; to: string; cc: string; date: string; subject: string };

/** Header lines for display. `date` is formatted in the viewer's own zone (or `timeZone`). */
export function extractHeaders(
  email: ParsedEmail,
  opts: { locale?: string; timeZone?: string } = {},
): EmailHeaders {
  let date = '';
  if (email.date) {
    const d = new Date(email.date);
    date = Number.isNaN(d.getTime())
      ? email.date
      : new Intl.DateTimeFormat(opts.locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
          ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
        }).format(d);
  }
  return {
    from: formatAddress(email.from),
    to: formatAddresses(email.to),
    cc: formatAddresses(email.cc),
    date,
    subject: email.subject ?? '',
  };
}

export function contentBytes(content: ParsedAttachment['content']): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const RASTER = /^image\/(png|jpe?g|gif|webp)$/i;

/** Replace `cid:` references (img src and CSS url()) with data: URLs of the matching inline parts. */
export function rewriteCid(html: string, attachments: ParsedAttachment[]): string {
  const byCid = new Map<string, ParsedAttachment>();
  for (const a of attachments) {
    if (!a.contentId || !RASTER.test(a.mimeType)) continue;
    byCid.set(a.contentId.replace(/^<|>$/g, '').toLowerCase(), a);
  }
  if (byCid.size === 0) return html;
  return html.replace(/cid:([^\s"'()<>]+)/gi, (whole, id: string) => {
    let key = id;
    try {
      key = decodeURIComponent(id);
    } catch {
      // keep the raw id
    }
    const a = byCid.get(key.toLowerCase());
    return a
      ? `data:${a.mimeType.toLowerCase()};base64,${toBase64(contentBytes(a.content))}`
      : whole;
  });
}

/** Whether the HTML refers to remote images (so the "Load remote images" button is worth showing). */
export function hasRemoteImages(html: string): boolean {
  return /(?:\bsrc|\bbackground|\bsrcset)\s*=\s*["']?\s*(?:https?:)?\/\/|(?:url|image-set)\(\s*["']?\s*(?:https?:)?\/\//i.test(
    html,
  );
}

export function emailCsp(remoteImages: boolean): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data: blob:${remoteImages ? ' https:' : ''}`,
    'font-src data:',
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

/**
 * Build the iframe `srcdoc` for an HTML email. The CSP meta comes first in <head>; links open in a new
 * tab with noopener noreferrer; meta refresh and <base> are removed. Parsing uses DOMParser, which is
 * inert (no scripts run, nothing is fetched). The sandbox and CSP are the actual security boundary.
 */
export function buildSrcdoc(
  html: string,
  attachments: ParsedAttachment[],
  opts: { remoteImages: boolean },
): string {
  const doc = new DOMParser().parseFromString(rewriteCid(html, attachments), 'text/html');
  for (const el of Array.from(
    doc.querySelectorAll('base, meta[http-equiv], script, object, embed, iframe, frame, link, svg'),
  ))
    el.remove();
  for (const a of Array.from(doc.querySelectorAll('a[href], area[href]'))) {
    a.removeAttribute('ping');
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', emailCsp(opts.remoteImages));
  const scheme = doc.createElement('meta');
  scheme.setAttribute('name', 'color-scheme');
  scheme.setAttribute('content', 'light');
  const style = doc.createElement('style');
  style.textContent =
    'html{background:#fff;color:#111}body{margin:12px;overflow-wrap:anywhere}img{max-width:100%;height:auto}';
  doc.head.prepend(csp, scheme, style);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

export type TextSegment = { text: string; href?: string };

/** Split plain text into runs, marking http(s) URLs. Rendered as React nodes, never as HTML. */
export function linkify(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
    const start = m.index;
    let url = m[0];
    // Trailing punctuation belongs to the sentence, not the URL.
    const trail = /[.,;:!?)\]'"]+$/.exec(url)?.[0] ?? '';
    url = url.slice(0, url.length - trail.length);
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Inner attachments to list under the body: everything except inline parts the HTML can show itself. */
export function listedAttachments(email: ParsedEmail): ParsedAttachment[] {
  return email.attachments.filter((a) => !(a.contentId && a.disposition === 'inline'));
}
