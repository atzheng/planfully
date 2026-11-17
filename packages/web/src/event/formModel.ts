// Pure logic behind EventForm: form values <-> Event fields, validation, diffing.
// No React here so it can be unit-tested directly.

import {
  EVENT_TYPES,
  EventSchema,
  toInstant,
  fromInstant,
  type Event,
  type EventType,
  type RecordBody,
  type Location,
  type LocalTime,
} from '@planfully/shared';

/** Fields of an edit patch (CONTRACTS.md section 3): optional fields are `null` to clear them. */
export type EventFields = Extract<RecordBody, { kind: 'patch' }>['fields'];

export type FormValues = {
  name: string;
  type: EventType;
  startDate: string;
  startTime: string;
  startTz: string;
  endDate: string;
  endTime: string;
  endTz: string;
  confirmation: string;
  locationName: string;
  locationAddress: string;
  endLocationName: string;
  endLocationAddress: string;
  participants: string[];
  status: Event['status'];
  notes: string;
};

export type FormErrors = Partial<Record<keyof FormValues | 'form', string>>;

export const TRANSPORT_TYPES: readonly EventType[] = ['flight', 'train', 'bus', 'ferry', 'car'];
export const isTransport = (t: EventType): boolean => TRANSPORT_TYPES.includes(t);
export { EVENT_TYPES };

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Zone for an empty time: the event's own zone, else the other time's, else the caller's default, else the browser's. */
export function defaultZones(
  initial: Partial<Pick<Event, 'start' | 'end'>>,
  fallback?: string,
): { startTz: string; endTz: string } {
  const base = initial.start?.tz ?? initial.end?.tz ?? fallback ?? browserZone();
  return {
    startTz: initial.start?.tz ?? base,
    endTz: initial.end?.tz ?? initial.start?.tz ?? base,
  };
}

export function initialValues(initial: Partial<Event> = {}, fallbackTz?: string): FormValues {
  const { startTz, endTz } = defaultZones(initial, fallbackTz);
  return {
    name: initial.name ?? '',
    type: initial.type ?? 'other',
    startDate: initial.start?.local.slice(0, 10) ?? '',
    startTime: initial.start?.local.slice(11, 16) ?? '',
    startTz,
    endDate: initial.end?.local.slice(0, 10) ?? '',
    endTime: initial.end?.local.slice(11, 16) ?? '',
    endTz,
    confirmation: initial.confirmation ?? '',
    locationName: initial.location?.name ?? '',
    locationAddress: initial.location?.address ?? '',
    endLocationName: initial.endLocation?.name ?? '',
    endLocationAddress: initial.endLocation?.address ?? '',
    participants: initial.participants ?? [],
    status: initial.status ?? 'confirmed',
    notes: initial.notes ?? '',
  };
}

/** Combine date, time and zone inputs. Blank date and time give `undefined`; half-filled is an error. */
export function buildLocalTime(
  date: string,
  time: string,
  tz: string,
): { value?: LocalTime; error?: string } {
  if (!date && !time) return {};
  if (!date) return { error: 'Enter a date' };
  if (!time) return { error: 'Enter a time' };
  const value = { local: `${date}T${time}`, tz };
  try {
    // A wall-clock time inside a DST gap does not exist; luxon would silently shift it.
    if (fromInstant(toInstant(value), tz).local !== value.local) {
      return { error: 'That time does not exist in this time zone (clocks skip it)' };
    }
  } catch {
    return { error: 'Not a valid date and time' };
  }
  return { value };
}

/** Trimmed input, or the original string untouched when they match once trimmed. */
function keepIfSame(input: string, original: string | undefined): string {
  const t = input.trim();
  return original !== undefined && original.trim() === t ? original : t;
}

function buildLocation(
  name: string,
  address: string,
  original: Location | undefined,
): Location | null | undefined {
  const n = name.trim();
  const a = address.trim();
  if (n === (original?.name ?? '').trim() && a === (original?.address ?? '').trim()) {
    return original;
  }
  if (!n && !a) return original ? null : undefined;
  // Text changed: coordinates and place id would now point somewhere else, so they are dropped.
  const loc: Location = {};
  if (n) loc.name = n;
  if (a) loc.address = a;
  return loc;
}

export type BuildResult = { ok: true; fields: EventFields } | { ok: false; errors: FormErrors };

/**
 * Validate the form and produce full event fields. A field that had a value and is now blank
 * becomes `null` (clears it, CONTRACTS.md section 3); blank start and end make the event
 * unscheduled. An end without a start is an error.
 */
export function buildFields(v: FormValues, original: Partial<Event> = {}): BuildResult {
  const errors: FormErrors = {};
  const name = keepIfSame(v.name, original.name);
  if (!name) errors.name = 'Enter a name';

  const start = buildLocalTime(v.startDate, v.startTime, v.startTz);
  const end = buildLocalTime(v.endDate, v.endTime, v.endTz);
  if (start.error) errors.startDate = start.error;
  if (end.error) errors.endDate = end.error;
  if (start.value && end.value && !errors.startDate && !errors.endDate) {
    if (toInstant(end.value) < toInstant(start.value)) errors.endDate = 'End is before the start';
  }
  // An end with no start is allowed (schema), unless the user just blanked a start that was set.
  if (end.value && !start.value && original.start && !errors.endDate && !errors.startDate) {
    errors.startDate = 'Enter a start before an end';
  }

  const fields: EventFields = {
    name,
    type: v.type,
    status: v.status,
    participants: v.participants,
  };
  if (start.value) fields.start = start.value;
  else if (!start.error && original.start) fields.start = null;
  if (end.value) fields.end = end.value;
  else if (!end.error && original.end) fields.end = null;
  const confirmation = keepIfSame(v.confirmation, original.confirmation);
  if (confirmation) fields.confirmation = confirmation;
  else if (original.confirmation !== undefined) fields.confirmation = null;
  const notes = keepIfSame(v.notes, original.notes);
  if (notes) fields.notes = notes;
  else if (original.notes !== undefined) fields.notes = null;
  const loc = buildLocation(v.locationName, v.locationAddress, original.location);
  if (loc !== undefined) fields.location = loc;
  if (isTransport(v.type)) {
    const endLoc = buildLocation(v.endLocationName, v.endLocationAddress, original.endLocation);
    if (endLoc !== undefined) fields.endLocation = endLoc;
  } else if (original.endLocation) {
    // The arrival fields are hidden for non-transport types; leave any existing value alone.
    fields.endLocation = original.endLocation;
  }

  if (Object.keys(errors).length === 0) {
    // Final check against the shared schema; the other required fields are filled in so only ours can fail.
    const probe = EventSchema.safeParse({
      attachments: [],
      source: 'manual',
      createdAt: 'x',
      ...Object.fromEntries(Object.entries(fields).filter(([, x]) => x !== null)),
      id: 'x',
    });
    if (!probe.success) {
      for (const issue of probe.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        const field = key === 'start' ? 'startDate' : key === 'end' ? 'endDate' : key;
        errors[field as keyof FormErrors] ??= issue.message;
      }
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, fields };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Only the fields whose value differs from `original`, so only those become pinned. */
export function diffFields(original: Event, next: EventFields): EventFields {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) continue;
    const prev = (original as Record<string, unknown>)[k];
    if (v === null) {
      if (prev !== undefined) out[k] = null; // clearing something already absent is no change
      continue;
    }
    if (k === 'participants') {
      if (same([...(prev as string[])].sort(), [...(v as string[])].sort())) continue;
    } else if (same(prev, v)) continue;
    out[k] = v;
  }
  return out as EventFields;
}

export function timeZones(extra: readonly string[] = []): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  let zones: string[];
  try {
    zones = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  return [...new Set([...extra, ...zones, 'UTC'])].sort();
}
