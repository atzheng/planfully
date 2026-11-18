// Sample trip data for `pnpm seed` and for tests elsewhere. Pure: no network, no clock
// (pass `now`), so it runs in Node, Workers and the browser.
//
// The trip is Lisbon and Porto, from 2 days ago to 10 days ahead of `now`, so "today" and
// the weather forecast window are both covered. Times are local wall-clock with an IANA zone.

import type {
  Attachment,
  Event,
  EventType,
  LocalTime,
  Location,
  RecordBody,
  RosterMember,
} from '@planfully/shared';

export type SampleRecord = { body: RecordBody; dedupe?: string };
export type SampleAttachment = Attachment & { bytes: Uint8Array };

export type SampleTrip = {
  name: string;
  roster: RosterMember[];
  /** Records in append order (seq order once posted). */
  records: SampleRecord[];
  /** Plaintext attachment files; each `id` is the blob id (a lowercase UUID). */
  attachments: SampleAttachment[];
  /** What folding `records` must give. */
  expected: {
    count: number;
    /** Name of the event that was put and then deleted; must be absent. */
    deletedName: string;
    /** The booking sent twice: one event, with the second put's start. */
    duplicate: { name: string; start: LocalTime; puts: number };
    /** The event that got a patch: the folded event must show these fields. */
    patched: { name: string; start: LocalTime; notes: string };
    /** Events with no start, only a location. */
    unscheduled: number;
  };
};

const NY = 'America/New_York';
const LIS = 'Europe/Lisbon';

const ALEX = 'p1';
const SAM = 'p2';
const JO = 'p3';
export const SAMPLE_ROSTER: RosterMember[] = [
  { id: ALEX, name: 'Alex', aliases: ['alex@example.com'] },
  { id: SAM, name: 'Sam', aliases: ['sam@example.com'] },
  { id: JO, name: 'Jo', aliases: ['joanna', 'jo@example.com'] },
];

/** 'YYYY-MM-DD' for `now`'s UTC date plus `offset` days. */
function day(now: Date, offset: number): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
  return d.toISOString().slice(0, 10);
}

const enc = new TextEncoder();

/** A 1x1 PNG. */
function tinyPng(): Uint8Array {
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** A one-page PDF with a line of text; xref offsets are computed. */
function tinyPdf(text: string): Uint8Array {
  const stream = `BT /F1 18 Tf 36 100 Td (${text}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
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
  return enc.encode(out);
}

function tinyEml(subject: string): Uint8Array {
  return enc.encode(
    [
      'From: bookings@example.com',
      'To: trip@example.com',
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Thanks for your payment. This is a sample message for the Planfully dev seed.',
      '',
    ].join('\r\n'),
  );
}

function b64Lines(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return (btoa(s).match(/.{1,76}/g) ?? []).join('\r\n');
}

/** An HTML email with an inline (cid) image, a remote image, a link and a PDF attachment. */
function richEml(): Uint8Array {
  const html = [
    '<html><body style="font-family:Georgia,serif">',
    '<h2 style="color:#7a1f3d">Rental car confirmation</h2>',
    '<p>Hello Alex, your car is booked. <a href="https://example.com/manage">Manage booking</a></p>',
    '<p><img src="cid:logo@planfully" width="120" height="40" alt="inline logo" style="background:#7a1f3d"></p>',
    '<p><img src="https://tracker.example.com/open.gif?u=1" width="80" height="20" alt="remote image"></p>',
    '<script>document.body.innerHTML="SCRIPT RAN"</script>',
    '<p>Pick-up: Lisbon airport, terminal 1.</p>',
    '</body></html>',
  ].join('\r\n');
  const parts = [
    'From: Hertz Bookings <bookings@example.com>',
    'To: Alex <alex@example.com>, Sam <sam@example.com>',
    'Subject: Your rental car is confirmed',
    'Date: Mon, 04 May 2026 14:05:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mix"',
    '',
    '--mix',
    'Content-Type: multipart/related; boundary="rel"',
    '',
    '--rel',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    '--rel',
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <logo@planfully>',
    'Content-Disposition: inline; filename="logo.png"',
    '',
    b64Lines(tinyPng()),
    '--rel--',
    '--mix',
    'Content-Type: application/pdf; name="rental-confirmation.pdf"',
    'Content-Disposition: attachment; filename="rental-confirmation.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(tinyPdf('Rental confirmation')),
    '--mix--',
    '',
  ];
  return enc.encode(parts.join('\r\n'));
}

export function buildSampleTrip(
  now: Date = new Date(),
  newId: () => string = () => crypto.randomUUID(),
): SampleTrip {
  const createdAt = now.toISOString();
  const t = (offset: number, hm: string, tz: string): LocalTime => ({
    local: `${day(now, offset)}T${hm}`,
    tz,
  });
  const loc = (name: string, lat: number, lng: number, address?: string): Location => ({
    name,
    lat,
    lng,
    ...(address ? { address } : {}),
  });

  const records: SampleRecord[] = [];
  const attachments: SampleAttachment[] = [];

  const attach = (
    filename: string,
    mime: string,
    kind: Attachment['kind'],
    bytes: Uint8Array,
  ): Attachment => {
    const meta: Attachment = { id: newId(), filename, mime, kind, size: bytes.length };
    attachments.push({ ...meta, bytes });
    return meta;
  };

  const put = (
    type: EventType,
    name: string,
    f: Partial<Omit<Event, 'id' | 'name' | 'type'>> = {},
    dedupe?: string,
  ): Event => {
    const event: Event = {
      id: newId(),
      name,
      type,
      attachments: [],
      participants: [],
      status: 'confirmed',
      source: 'email',
      createdAt,
      ...f,
    };
    records.push({ body: { kind: 'put', event }, ...(dedupe ? { dedupe } : {}) });
    return event;
  };

  // --- transport -------------------------------------------------------------------------
  // Written in the pre-merge shape (type 'flight', no mode) on purpose: proves that records
  // stored before the transit merge still read as Transit + plane icon.
  const legacy = put('transit', 'TP204 New York to Lisbon', {
    mode: 'flight',
    start: t(-2, '19:35', NY),
    end: t(-1, '07:30', LIS),
    location: loc('John F. Kennedy International Airport', 40.6413, -73.7781),
    endLocation: loc('Lisbon Humberto Delgado Airport', 38.7742, -9.1342),
    confirmation: 'XK4P7Q',
  });
  const legacyRaw: { type: string; mode?: string } = legacy;
  legacyRaw.type = 'flight';
  delete legacyRaw.mode;
  put('transit', 'Alfa Pendular Lisbon to Porto', {
    mode: 'train',
    start: t(4, '10:04', LIS),
    end: t(4, '12:59', LIS),
    location: loc('Lisboa Santa Apolonia', 38.7141, -9.1226),
    endLocation: loc('Porto Campanha', 41.1489, -8.5855),
    confirmation: 'CP88213',
    participants: [ALEX, SAM],
  });
  put('transit', 'Rental car (Porto)', {
    mode: 'car',
    start: t(5, '09:30', LIS),
    end: t(8, '18:00', LIS),
    location: loc('Porto Airport Rent-a-car', 41.2481, -8.6814),
    endLocation: loc('Porto Airport Rent-a-car', 41.2481, -8.6814),
    confirmation: 'RC-559012',
    participants: [ALEX, JO],
  });
  put('transit', 'TP209 Porto to New York', {
    mode: 'flight',
    start: t(10, '11:20', LIS),
    end: t(10, '14:05', NY),
    location: loc('Porto Airport', 41.2481, -8.6814),
    endLocation: loc('John F. Kennedy International Airport', 40.6413, -73.7781),
    confirmation: 'XK4P7Q',
  });

  // --- lodging ---------------------------------------------------------------------------
  put('lodging', 'Memmo Alfama Hotel', {
    start: t(-1, '15:00', LIS),
    end: t(4, '11:00', LIS),
    location: loc('Memmo Alfama', 38.7116, -9.1296, 'Travessa das Merceeiras 27, Lisbon'),
    confirmation: 'MEM-30417',
  });
  put('lodging', 'Pestana Vintage Porto', {
    start: t(4, '14:00', LIS),
    end: t(10, '08:00', LIS),
    location: loc('Pestana Vintage Porto', 41.1403, -8.6143, 'Praca da Ribeira 1, Porto'),
    confirmation: 'PST-77120',
  });

  // --- Lisbon: dining and activities -----------------------------------------------------
  put('dining', 'Time Out Market lunch', {
    start: t(-1, '13:00', LIS),
    end: t(-1, '14:30', LIS),
    location: loc('Time Out Market Lisboa', 38.7068, -9.1459),
  });
  const alfama = put('activity', 'Alfama walking tour', {
    start: t(0, '10:00', LIS),
    end: t(0, '12:30', LIS),
    location: loc('Miradouro de Santa Luzia', 38.7118, -9.1301),
    confirmation: 'WALK-2291',
    participants: [ALEX, SAM, JO],
  });
  put('dining', 'Pasteis de Belem', {
    start: t(0, '15:30', LIS),
    location: loc('Pasteis de Belem', 38.6976, -9.2033),
    participants: [SAM],
  });
  put('activity', 'Sintra day trip (guided)', {
    start: t(1, '09:00', LIS),
    end: t(1, '17:00', LIS),
    location: loc('Sintra', 38.7979, -9.3881),
    confirmation: 'SNT-4410',
  });
  // overlaps the day trip
  put('activity', 'Pena Palace entry', {
    start: t(1, '11:00', LIS),
    end: t(1, '12:30', LIS),
    location: loc('Pena Palace', 38.7876, -9.3906),
    confirmation: 'PENA-9087',
    participants: [ALEX, JO],
  });
  put('dining', 'Belcanto dinner', {
    start: t(2, '20:00', LIS),
    end: t(2, '22:30', LIS),
    location: loc('Belcanto', 38.7106, -9.1423),
    confirmation: 'BEL-5521',
    participants: [ALEX, SAM],
    needsReview: true,
  });
  put('activity', 'Fado night at Clube de Fado', {
    start: t(3, '21:00', LIS),
    location: loc('Clube de Fado', 38.7099, -9.1269),
    status: 'cancelled',
    notes: 'Venue closed for a private event.',
  });
  put('activity', 'LX Factory coffee and books', {
    start: t(3, '16:00', LIS),
    end: t(3, '17:30', LIS),
    location: loc('LX Factory', 38.7035, -9.1788),
    source: 'manual',
    participants: [JO],
  });

  // The same booking sent twice (same dedupe tag); the second has a changed time.
  const ramiroFields = {
    location: loc('Cervejaria Ramiro', 38.7228, -9.1349),
    confirmation: 'RAM-1042',
    participants: [ALEX, SAM, JO],
  };
  const ramiroStart = t(2, '13:30', LIS);
  put(
    'dining',
    'Cervejaria Ramiro',
    { ...ramiroFields, start: t(2, '13:00', LIS) },
    'sample-dedupe-ramiro',
  );
  put(
    'dining',
    'Cervejaria Ramiro',
    { ...ramiroFields, start: ramiroStart, notes: 'Time changed by the restaurant.' },
    'sample-dedupe-ramiro',
  );

  // --- Porto: dining and activities ------------------------------------------------------
  put('dining', 'Cafe Majestic', {
    start: t(5, '16:00', LIS),
    location: loc('Cafe Majestic', 41.1469, -8.6064),
    participants: [SAM, JO],
  });
  put('activity', "Taylor's port cellar tour", {
    start: t(6, '11:00', LIS),
    end: t(6, '12:30', LIS),
    location: loc("Taylor's Port Wine Cellars", 41.1384, -8.6137),
    confirmation: 'TAY-1180',
  });
  put('activity', 'Douro Valley river cruise', {
    start: t(7, '09:30', LIS),
    end: t(7, '17:30', LIS),
    location: loc('Cais da Ribeira', 41.1406, -8.6112),
    confirmation: 'DOU-6642',
    participants: [ALEX, SAM, JO],
  });
  put('dining', 'Cantinho do Avillez', {
    start: t(8, '20:00', LIS),
    location: loc('Cantinho do Avillez', 41.1457, -8.6143),
    participants: [ALEX, SAM],
  });
  put('activity', 'Francesinha tasting', {
    start: t(9, '13:00', LIS),
    end: t(9, '14:30', LIS),
    location: loc('Cafe Santiago', 41.1475, -8.6117),
    source: 'manual',
  });

  // --- unscheduled attractions (a location only) -----------------------------------------
  const unscheduled = [
    put('attraction', 'Oceanario de Lisboa', { location: loc('Oceanario', 38.7634, -9.0937) }),
    put('attraction', 'Torre de Belem', { location: loc('Torre de Belem', 38.6916, -9.216) }),
    put('attraction', 'Livraria Lello', { location: loc('Livraria Lello', 41.1469, -8.6151) }),
    put('attraction', 'Clerigos Tower', { location: loc('Torre dos Clerigos', 41.1458, -8.6146) }),
  ];

  // --- receipts with attachments: one PNG, one PDF, one source email ---------------------
  put('receipt', 'Airport taxi receipt', {
    start: t(-1, '09:10', LIS),
    location: loc('Lisbon Humberto Delgado Airport', 38.7742, -9.1342),
    attachments: [attach('taxi-receipt.png', 'image/png', 'file', tinyPng())],
    participants: [ALEX],
  });
  put('receipt', 'Rental car deposit', {
    start: t(5, '09:45', LIS),
    attachments: [
      attach(
        'rental-deposit.pdf',
        'application/pdf',
        'file',
        tinyPdf('Rental car deposit EUR 300'),
      ),
      attach('rental-confirmation.eml', 'message/rfc822', 'source-email', richEml()),
    ],
    participants: [ALEX, JO],
  });
  put('receipt', 'Belcanto deposit', {
    start: t(1, '10:00', LIS),
    attachments: [
      attach('belcanto-receipt.eml', 'message/rfc822', 'source-email', tinyEml('Your deposit')),
    ],
    participants: [ALEX, SAM],
  });

  // --- one patched, one deleted ----------------------------------------------------------
  const patchedStart = t(0, '10:30', LIS);
  const patchedNotes = 'Meet at the Santa Luzia viewpoint; moved half an hour later.';
  records.push({
    body: {
      kind: 'patch',
      target: alfama.id,
      fields: { start: patchedStart, end: t(0, '13:00', LIS), notes: patchedNotes },
    },
  });

  const deletedName = 'Museu do Azulejo';
  const deleted = put('activity', deletedName, {
    start: t(3, '11:00', LIS),
    location: loc('Museu Nacional do Azulejo', 38.7243, -9.1138),
  });
  records.push({ body: { kind: 'delete', target: deleted.id } });

  const puts = records.filter((r) => r.body.kind === 'put').length;
  const count = puts - 1 /* duplicate put merged */ - 1; /* deleted */

  return {
    name: 'Lisbon and Porto (sample)',
    roster: SAMPLE_ROSTER,
    records,
    attachments,
    expected: {
      count,
      deletedName,
      duplicate: { name: 'Cervejaria Ramiro', start: ramiroStart, puts: 2 },
      patched: { name: alfama.name, start: patchedStart, notes: patchedNotes },
      unscheduled: unscheduled.length,
    },
  };
}
