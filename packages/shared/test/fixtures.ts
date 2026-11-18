import type { Event, ParsedEvent, TripMeta } from '../src/schema';

export const flightEvent: Event = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'UA 57 SFO to CDG',
  type: 'transit',
  mode: 'flight',
  start: { local: '2026-06-01T16:30', tz: 'America/Los_Angeles' },
  end: { local: '2026-06-02T12:05', tz: 'Europe/Paris' },
  confirmation: 'ABC123',
  location: { name: 'San Francisco International Airport', lat: 37.6213, lng: -122.379 },
  endLocation: { name: 'Paris Charles de Gaulle Airport', lat: 49.0097, lng: 2.5479 },
  attachments: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      filename: 'ticket.pdf',
      mime: 'application/pdf',
      size: 1234,
      kind: 'file',
    },
  ],
  participants: [],
  status: 'confirmed',
  source: 'email',
  createdAt: '2026-05-01T10:00:00.000Z',
};

export const lodgingEvent: Event = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Hotel Le Marais',
  type: 'lodging',
  start: { local: '2026-06-02T15:00', tz: 'Europe/Paris' },
  end: { local: '2026-06-05T11:00', tz: 'Europe/Paris' },
  confirmation: 'HLM-998877',
  location: { name: 'Hotel Le Marais', address: '12 Rue des Archives, 75004 Paris' },
  attachments: [],
  participants: ['alice'],
  status: 'confirmed',
  notes: 'Late check-in requested',
  source: 'manual',
  needsReview: true,
  createdAt: '2026-05-01T10:05:00.000Z',
  pinned: ['notes'],
};

/** No start: appears only on the map and in the unscheduled list. */
export const landmarkEvent: Event = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Eiffel Tower',
  type: 'attraction',
  location: { name: 'Eiffel Tower', lat: 48.8584, lng: 2.2945 },
  attachments: [],
  participants: [],
  status: 'confirmed',
  source: 'manual',
  createdAt: '2026-05-02T08:00:00.000Z',
};

export const sampleEvents: Event[] = [flightEvent, lodgingEvent, landmarkEvent];

export const sampleParsedEvents: ParsedEvent[] = [
  {
    name: 'UA 57 SFO to CDG',
    type: 'transit',
    mode: 'flight',
    start: { local: '2026-06-01T16:30', tz: 'America/Los_Angeles' },
    end: { local: '2026-06-02T12:05', tz: 'Europe/Paris' },
    confirmation: 'ABC123',
    location: { name: 'SFO' },
    endLocation: { name: 'CDG' },
    participants: [],
    status: 'confirmed',
    attachmentIndexes: [0],
  },
  {
    name: 'Dinner at Septime',
    type: 'dining',
    participants: ['alice'],
    status: 'confirmed',
    attachmentIndexes: [],
  },
];

export const sampleTripMeta: TripMeta = {
  id: 'trip-1',
  name: 'Paris 2026',
  address: 'paris-x7k2qa',
  domain: 'example.test',
  publicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  roster: [{ id: 'alice', name: 'Alice', aliases: ['Ali'] }],
  allowedSenders: ['alice@example.com'],
  createdAt: '2026-05-01T09:00:00.000Z',
};
