import { describe, expect, test } from 'vitest';
import { MAX_HTML_CHARS, htmlToText, htmlToTextLimited } from '../../src/llm/html';

describe('htmlToText', () => {
  const html = `<html><head><title>x</title><style>td{color:red}</style></head><body>
    <script>alert('tracking')</script>
    <div style="display:none">preheader junk</div>
    <h1>Your trip &amp; tickets</h1>
    <table>
      <tr><th>Flight</th><th>From</th><th>To</th><th>Departs</th></tr>
      <tr><td>UA&nbsp;57</td><td>SFO</td><td>CDG</td><td>16:30</td></tr>
      <tr><td>UA 58</td><td>CDG</td><td>SFO</td><td>10:00</td></tr>
    </table>
    <p>Confirmation:<br><b>ABC123</b></p>
    <ul><li>Bag</li><li>Seat 12A</li></ul>
    <img src="https://t.example/pixel.gif" width="1" height="1">
  </body></html>`;

  test('keeps table rows readable', () => {
    const out = htmlToText(html);
    expect(out).toContain('Flight | From | To | Departs');
    expect(out).toContain('UA 57 | SFO | CDG | 16:30');
    expect(out).toContain('UA 58 | CDG | SFO | 10:00');
    expect(out).toContain('Your trip & tickets');
    expect(out).toContain('Confirmation:\nABC123');
    expect(out).toContain('- Seat 12A');
  });

  test('drops scripts, styles, head, hidden and images', () => {
    const out = htmlToText(html);
    expect(out).not.toContain('alert');
    expect(out).not.toContain('tracking');
    expect(out).not.toContain('color:red');
    expect(out).not.toContain('preheader');
    expect(out).not.toContain('pixel');
    expect(out).not.toContain('<');
  });

  test('decodes numeric entities and collapses blank lines', () => {
    expect(htmlToText('<p>caf&#233; &#x41;</p><p></p><p></p><p>x</p>')).toBe('café A\n\nx');
  });

  test('font-size:0.9em is not hidden, exact zero is', () => {
    expect(htmlToText('<table><tr><td style="font-size:0.9em">CDG</td></tr></table>')).toContain(
      'CDG',
    );
    expect(htmlToText('<div style="font-size: 0.75rem">keep</div>')).toContain('keep');
    expect(htmlToText('<div style="font-size:0">gone</div>x')).not.toContain('gone');
    expect(htmlToText('<span style="font-size:0px;color:red">gone</span>x')).not.toContain('gone');
  });

  test('nested divs inside a hidden div are fully dropped', () => {
    const out = htmlToText(
      '<div style="display:none"><div>inner</div>leak after inner</div><p>visible</p>',
    );
    expect(out).not.toContain('inner');
    expect(out).not.toContain('leak');
    expect(out).toContain('visible');
  });

  test('single-quoted style attributes are honoured', () => {
    const out = htmlToText("<div style='display: none'>secret</div><div>shown</div>");
    expect(out).not.toContain('secret');
    expect(out).toContain('shown');
  });

  test('truncates oversized input and reports it', () => {
    const r = htmlToTextLimited('a'.repeat(MAX_HTML_CHARS + 10));
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBe(MAX_HTML_CHARS);
    expect(htmlToTextLimited('<p>hi</p>').truncated).toBe(false);
  });

  describe('linear time on adversarial input', () => {
    // Wall-clock limits flake under parallel load, so assert scaling instead: the same
    // pattern at 8x the size must cost well under the 64x a quadratic parser would.
    const cases: [string, string, number][] = [
      ['unclosed script', '<script>', 1e4],
      ['nested hidden divs', '<div style="display:none">', 1e4],
      ['unterminated style attribute', '<td style="', 2e3],
      ['unterminated tags', '<a ', 2e4],
      ['lone angle brackets', '<', 5e4],
    ];
    const best = (input: string) => {
      let min = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        htmlToText(input);
        min = Math.min(min, performance.now() - t);
      }
      return min;
    };
    for (const [name, unit, n] of cases) {
      test(`${name} scales linearly`, () => {
        const small = best(unit.repeat(n));
        const large = best(unit.repeat(n * 8));
        // Linear is ~8x; quadratic is ~64x. The floor keeps sub-millisecond noise from counting.
        expect(large).toBeLessThan(Math.max(small, 2) * 32);
      });
    }
  });
});
