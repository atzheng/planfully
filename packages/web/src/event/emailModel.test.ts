import { describe, expect, test } from 'vitest';
import {
  EMAIL_IFRAME_SANDBOX,
  buildSrcdoc,
  emailCsp,
  extractHeaders,
  hasRemoteImages,
  isEmailAttachment,
  linkify,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  listedAttachments,
  rewriteCid,
  type ParsedAttachment,
  type ParsedEmail,
} from './emailModel';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES));

const png: ParsedAttachment = {
  filename: 'logo.png',
  mimeType: 'image/png',
  disposition: 'inline',
  contentId: '<logo@x>',
  content: PNG_BYTES,
};
const pdf: ParsedAttachment = {
  filename: 'conf.pdf',
  mimeType: 'application/pdf',
  disposition: 'attachment',
  content: new Uint8Array([4]),
};

describe('isEmailAttachment', () => {
  test('mime or extension', () => {
    expect(isEmailAttachment({ mime: 'message/rfc822', filename: 'x' })).toBe(true);
    expect(isEmailAttachment({ mime: 'application/octet-stream', filename: 'A.EML' })).toBe(true);
    expect(isEmailAttachment({ mime: 'application/pdf', filename: 'a.pdf' })).toBe(false);
  });
});

describe('extractHeaders', () => {
  const email: ParsedEmail = {
    from: { name: 'Hotel', address: 'h@example.com' },
    to: [{ address: 'a@example.com' }, { name: 'Sam', address: 's@example.com' }],
    date: '2026-05-05T09:48:00.000Z',
    subject: 'Booking',
    attachments: [],
  };
  test('formats addresses and the date in the given zone', () => {
    const h = extractHeaders(email, { locale: 'en-US', timeZone: 'Europe/Lisbon' });
    expect(h.from).toBe('Hotel <h@example.com>');
    expect(h.to).toBe('a@example.com, Sam <s@example.com>');
    expect(h.date).toContain('10:48');
    expect(h.subject).toBe('Booking');
  });
  test('tolerates missing fields and bad dates', () => {
    const h = extractHeaders({ date: 'nonsense', attachments: [] });
    expect(h).toEqual({ from: '', to: '', cc: '', date: 'nonsense', subject: '' });
  });
});

describe('rewriteCid', () => {
  test('replaces img src and css url, case-insensitively and without brackets', () => {
    const out = rewriteCid(
      '<img src="cid:LOGO@x"><div style="background:url(cid:logo@x)"></div><img src="cid:other">',
      [png],
    );
    expect(out.split(`data:image/png;base64,${PNG_B64}`).length - 1).toBe(2);
    expect(out).toContain('cid:other');
  });
  test('leaves oversized, over-budget and signature-mismatched images as cid:', () => {
    const big = new Uint8Array(MAX_INLINE_IMAGE_BYTES + 1);
    big.set(PNG_BYTES);
    expect(rewriteCid('<img src="cid:logo@x">', [{ ...png, content: big }])).toBe(
      '<img src="cid:logo@x">',
    );
    const fake = { ...png, content: new Uint8Array([1, 2, 3]) };
    expect(rewriteCid('<img src="cid:logo@x">', [fake])).toBe('<img src="cid:logo@x">');
  });
  test('stops inlining once the total budget is spent', () => {
    const chunk = new Uint8Array(MAX_INLINE_IMAGE_BYTES);
    chunk.set(PNG_BYTES);
    const parts = Array.from({ length: 200 }, (_, i) => ({
      ...png,
      contentId: `<i${i}>`,
      content: chunk,
    }));
    const html = parts.map((_, i) => `<img src="cid:i${i}">`).join('');
    const out = rewriteCid(html, parts);
    expect(out.split('data:image/png').length - 1).toBe(
      Math.floor(MAX_INLINE_TOTAL_BYTES / MAX_INLINE_IMAGE_BYTES),
    );
    expect(out).toContain('cid:i199');
  });
  test('ignores non-raster inline parts', () => {
    const svg = { ...png, mimeType: 'image/svg+xml' };
    expect(rewriteCid('<img src="cid:logo@x">', [svg])).toBe('<img src="cid:logo@x">');
  });
});

describe('buildSrcdoc', () => {
  const html =
    '<html><head><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example"></head>' +
    '<body><script>alert(1)</script><a href="https://example.com">x</a><img src="cid:logo@x"></body></html>';

  test('contains the CSP first in head, blocking remote images by default', () => {
    const doc = buildSrcdoc(html, [png], { remoteImages: false });
    expect(doc).toContain(emailCsp(false));
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toMatch(/img-src[^"]*https:/);
    expect(doc.indexOf('<head>')).toBeLessThan(doc.indexOf('Content-Security-Policy'));
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<body'));
    expect(doc).not.toContain('<script');
    expect(doc).toContain(`data:image/png;base64,${PNG_B64}`);
  });
  test('remote images allowed only when asked', () => {
    expect(buildSrcdoc(html, [], { remoteImages: true })).toMatch(/img-src data: blob: https:/);
  });
  test('links get target and noopener noreferrer; base and meta refresh removed', () => {
    const doc = buildSrcdoc(html, [], { remoteImages: false });
    expect(doc).toContain('rel="noopener noreferrer"');
    expect(doc).toContain('target="_blank"');
    expect(doc).not.toContain('<base');
    expect(doc).not.toContain('refresh');
  });
  test('strips link, svg and ping so nothing is prefetched or navigates the frame', () => {
    const doc = buildSrcdoc(
      '<head><link rel="dns-prefetch" href="//t.example"><link rel="preconnect" href="https://t.example"></head>' +
        '<body><a href="https://x.example" ping="https://t.example/p">x</a>' +
        '<svg><a xlink:href="https://evil.example"><text>hi</text></a></svg></body>',
      [],
      { remoteImages: false },
    );
    expect(doc).not.toContain('<link');
    expect(doc).not.toContain('ping=');
    expect(doc).not.toContain('<svg');
    expect(doc).not.toContain('evil.example');
  });
  test('the iframe sandbox never allows scripts or same-origin', () => {
    expect(EMAIL_IFRAME_SANDBOX).not.toMatch(/allow-scripts/);
    expect(EMAIL_IFRAME_SANDBOX).not.toMatch(/allow-same-origin/);
  });
});

describe('hasRemoteImages', () => {
  test('detects src and url() but not cid or data', () => {
    expect(hasRemoteImages('<img src="https://t.example/p.gif">')).toBe(true);
    expect(hasRemoteImages('<td background="http://t.example/b.png">')).toBe(true);
    expect(hasRemoteImages('<div style="background:url(https://t.example/b.png)">')).toBe(true);
    expect(hasRemoteImages('<div style="background:image-set(https://t.example/a.png 1x)">')).toBe(
      true,
    );
    expect(hasRemoteImages('<img src="cid:a"><img src="data:image/png;base64,AA">')).toBe(false);
  });
});

describe('linkify', () => {
  test('splits urls and keeps trailing punctuation out', () => {
    expect(linkify('See https://a.example/x?y=1, then (https://b.example).')).toEqual([
      { text: 'See ' },
      { text: 'https://a.example/x?y=1', href: 'https://a.example/x?y=1' },
      { text: ', then (' },
      { text: 'https://b.example', href: 'https://b.example' },
      { text: ').' },
    ]);
  });
  test('only http(s) becomes a link; html stays text', () => {
    const segs = linkify('<img src=x onerror=1> javascript:alert(1)');
    expect(segs.every((s) => !s.href)).toBe(true);
  });
});

describe('listedAttachments', () => {
  test('omits inline cid parts', () => {
    expect(listedAttachments({ attachments: [png, pdf] })).toEqual([pdf]);
  });
});
