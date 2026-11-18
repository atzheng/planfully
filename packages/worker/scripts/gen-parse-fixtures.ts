// Regenerates the two parse fixtures that carry a real (tiny, text-only) PDF attachment:
//   test/fixtures/emails/parse/hotel-pdf.eml and train-pdf.eml
// Run with: pnpm --filter @planfully/worker exec tsx scripts/gen-parse-fixtures.ts
// The other fixtures are plain hand-written .eml files. All content is synthetic.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A one-page PDF with Helvetica text lines. Real, valid PDF (xref table included). */
export function makePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const ops = ['BT', '/F1 12 Tf', '14 TL', '50 780 Td'];
  lines.forEach((l, i) => {
    if (i > 0) ops.push('T*');
    ops.push(`(${esc(l)}) Tj`);
  });
  ops.push('ET');
  const stream = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function b64Lines(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString('base64');
  return (b64.match(/.{1,76}/g) ?? []).join('\r\n');
}

function eml(headers: string[], body: string, pdfName: string, pdf: Uint8Array): string {
  return [
    ...headers,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="pdfb"',
    '',
    '--pdfb',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
    '--pdfb',
    `Content-Type: application/pdf; name="${pdfName}"`,
    `Content-Disposition: attachment; filename="${pdfName}"`,
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(pdf),
    '--pdfb--',
    '',
  ].join('\r\n');
}

const dir = fileURLToPath(new URL('../test/fixtures/emails/parse/', import.meta.url));

writeFileSync(
  `${dir}hotel-pdf.eml`,
  eml(
    [
      'From: Hotel Le Marais <reservations@lemarais-hotel.example>',
      'To: trip@trips.example.com',
      'Subject: Your reservation HM-884213 - confirmation attached',
      'Date: Tue, 05 May 2026 09:48:00 +0000',
    ],
    'Dear Ms Smith,\r\n\r\nThank you for choosing Hotel Le Marais. Your booking reference is HM-884213.\r\nYour full confirmation is attached as a PDF.\r\n\r\nWarm regards,\r\nReservations',
    'confirmation-HM-884213.pdf',
    makePdf([
      'HOTEL LE MARAIS - RESERVATION CONFIRMATION',
      '',
      'Reservation number: HM-884213',
      'Guest: Alice Smith',
      'Hotel: Hotel Le Marais, 12 Rue de Turenne, 75003 Paris, France',
      'Arrival: Saturday 13 June 2026 (check-in from 15:00)',
      'Departure: Monday 22 June 2026 (check-out by 11:00)',
      'Room: Deluxe Double, 2 guests, breakfast not included',
      'Rate: EUR 214.00 per night',
      '',
      'Free cancellation until 6 June 2026.',
    ]),
  ),
);

writeFileSync(
  `${dir}train-pdf.eml`,
  eml(
    [
      'From: RailLink France <tickets@raillink.example>',
      'To: trip@trips.example.com',
      'Subject: Your e-tickets - order XTR4PQ',
      'Date: Wed, 06 May 2026 16:20:00 +0000',
    ],
    'Your e-tickets are attached. Please have them ready on your phone or printed.\r\n\r\nOrder: XTR4PQ',
    'tickets-XTR4PQ.pdf',
    makePdf([
      'RAILLINK FRANCE - E-TICKET',
      '',
      'Order reference: XTR4PQ',
      'Passengers: SMITH Alice, JONES Bob',
      'Train: TGV 6609',
      'Date: Tuesday 16 June 2026',
      'Depart: Paris Gare de Lyon at 09:07',
      'Arrive: Lyon Part-Dieu at 11:05',
      'Coach 11, seats 62 and 63, 2nd class',
    ]),
  ),
);
console.log('wrote hotel-pdf.eml and train-pdf.eml');
