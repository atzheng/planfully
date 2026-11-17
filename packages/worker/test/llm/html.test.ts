import { describe, expect, test } from 'vitest';
import { htmlToText } from '../../src/llm/html';

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
});
