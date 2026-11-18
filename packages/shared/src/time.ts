import { DateTime } from 'luxon';
import type { Event, LocalTime } from './schema';

function toDateTime(t: LocalTime): DateTime {
  // Nonexistent local times (spring-forward gap) are resolved by luxon: shifted forward by the gap
  // (02:30 -> 03:30). Ambiguous times (fall-back overlap) resolve to the later, standard-time occurrence.
  const dt = DateTime.fromISO(t.local, { zone: t.tz });
  if (!dt.isValid) throw new Error(`invalid local time: ${t.local} ${t.tz}`);
  return dt;
}

/** Epoch ms of a local time in its zone. */
export function toInstant(t: LocalTime): number {
  return toDateTime(t).toMillis();
}

export function fromInstant(ms: number, tz: string): LocalTime {
  const dt = DateTime.fromMillis(ms, { zone: tz });
  if (!dt.isValid) throw new Error(`invalid zone: ${tz}`);
  return { local: dt.toFormat("yyyy-MM-dd'T'HH:mm"), tz };
}

/** 'YYYY-MM-DD' in the time's own zone. */
export function dayKey(t: LocalTime): string {
  return t.local.slice(0, 10);
}

// Zone abbreviations. Browser ICU / luxon `offsetNameShort` differ between engines and locales
// (Lisbon is "GMT+0" in one, "WET" in another), so we use our own table of common zones. Only the
// numeric offset from luxon is used, which is stable everywhere.
// [standard abbreviation, standard offset in minutes, daylight abbreviation (offset = standard + 60)]
type AbbrRow = readonly [string, number, string?];
const eu = (std: string, dst: string, off: number): AbbrRow => [std, off, dst];
const cet = [
  'Paris',
  'Berlin',
  'Madrid',
  'Rome',
  'Amsterdam',
  'Brussels',
  'Vienna',
  'Zurich',
  'Prague',
  'Warsaw',
  'Budapest',
  'Stockholm',
  'Oslo',
  'Copenhagen',
  'Belgrade',
  'Zagreb',
  'Luxembourg',
  'Monaco',
  'Malta',
  'Bratislava',
  'Ljubljana',
  'Sarajevo',
  'Skopje',
  'Tirane',
  'Andorra',
];
const eet = [
  'Athens',
  'Helsinki',
  'Kiev',
  'Kyiv',
  'Bucharest',
  'Sofia',
  'Riga',
  'Tallinn',
  'Vilnius',
];
const ZONE_ABBR: Record<string, AbbrRow> = {
  'Europe/London': eu('GMT', 'BST', 0),
  'Europe/Dublin': eu('GMT', 'IST', 0),
  'Europe/Lisbon': eu('WET', 'WEST', 0),
  'Atlantic/Canary': eu('WET', 'WEST', 0),
  'Atlantic/Reykjavik': ['GMT', 0],
  ...Object.fromEntries(cet.map((c) => [`Europe/${c}`, eu('CET', 'CEST', 60)])),
  ...Object.fromEntries(eet.map((c) => [`Europe/${c}`, eu('EET', 'EEST', 120)])),
  'Europe/Istanbul': ['TRT', 180],
  'Europe/Moscow': ['MSK', 180],
  'Africa/Cairo': ['EET', 120, 'EEST'],
  'Africa/Johannesburg': ['SAST', 120],
  'Africa/Lagos': ['WAT', 60],
  'Africa/Nairobi': ['EAT', 180],
  'Asia/Dubai': ['GST', 240],
  'Asia/Karachi': ['PKT', 300],
  'Asia/Kolkata': ['IST', 330],
  'Asia/Calcutta': ['IST', 330],
  'Asia/Bangkok': ['ICT', 420],
  'Asia/Ho_Chi_Minh': ['ICT', 420],
  'Asia/Jakarta': ['WIB', 420],
  'Asia/Singapore': ['SGT', 480],
  'Asia/Kuala_Lumpur': ['MYT', 480],
  'Asia/Manila': ['PHT', 480],
  'Australia/Perth': ['AWST', 480],
  'Asia/Tokyo': ['JST', 540],
  'Asia/Seoul': ['KST', 540],
  'Australia/Adelaide': ['ACST', 570, 'ACDT'],
  'Australia/Darwin': ['ACST', 570],
  'Australia/Brisbane': ['AEST', 600],
  'Australia/Sydney': ['AEST', 600, 'AEDT'],
  'Australia/Melbourne': ['AEST', 600, 'AEDT'],
  'Australia/Hobart': ['AEST', 600, 'AEDT'],
  'Pacific/Auckland': ['NZST', 720, 'NZDT'],
  'Pacific/Honolulu': ['HST', -600],
  'America/Anchorage': ['AKST', -540, 'AKDT'],
  'America/Los_Angeles': ['PST', -480, 'PDT'],
  'America/Vancouver': ['PST', -480, 'PDT'],
  'America/Tijuana': ['PST', -480, 'PDT'],
  'America/Phoenix': ['MST', -420],
  'America/Denver': ['MST', -420, 'MDT'],
  'America/Edmonton': ['MST', -420, 'MDT'],
  'America/Chicago': ['CST', -360, 'CDT'],
  'America/Winnipeg': ['CST', -360, 'CDT'],
  'America/Mexico_City': ['CST', -360],
  'America/New_York': ['EST', -300, 'EDT'],
  'America/Toronto': ['EST', -300, 'EDT'],
  'America/Detroit': ['EST', -300, 'EDT'],
  'America/Bogota': ['COT', -300],
  'America/Lima': ['PET', -300],
  'America/Halifax': ['AST', -240, 'ADT'],
  'America/Puerto_Rico': ['AST', -240],
  'America/Santiago': ['CLT', -240, 'CLST'],
  'America/Sao_Paulo': ['BRT', -180],
  'America/Argentina/Buenos_Aires': ['ART', -180],
  'America/Buenos_Aires': ['ART', -180],
  'America/St_Johns': ['NST', -210, 'NDT'],
};

/** Fallback label: 'UTC', 'UTC+2', 'UTC-3', 'UTC+5:30' (minutes only when non-zero). */
export function utcOffsetLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return 'UTC';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/**
 * Short zone name at an instant, the same in every browser: 'WET'/'WEST' for Lisbon, 'CET'/'CEST' for
 * Paris, 'JST' for Tokyo. Daylight time is detected from the zone's UTC offset at `ms` versus its
 * standard offset. Zones not in the table (or at an unexpected offset) give `utcOffsetLabel`, e.g.
 * 'UTC+5:30'. An invalid zone returns `tz` unchanged.
 */
export function zoneAbbreviation(tz: string, ms: number): string {
  const dt = DateTime.fromMillis(ms, { zone: tz });
  if (!dt.isValid) return tz;
  const off = dt.offset;
  const row = ZONE_ABBR[tz];
  if (row) {
    const [std, stdOff, dst] = row;
    if (off === stdOff) return std;
    if (dst && off === stdOff + 60) return dst;
  }
  return utcOffsetLabel(off);
}

/** `zoneAbbreviation` for a local time in its own zone. */
export function localTimeAbbreviation(t: LocalTime): string {
  try {
    return zoneAbbreviation(t.tz, toInstant(t));
  } catch {
    return t.tz;
  }
}

/** Absolute interval of a scheduled event; null when unscheduled. `end` defaults to `start`. */
export function eventInterval(
  e: Pick<Event, 'start' | 'end'>,
): { start: number; end: number } | null {
  if (!e.start) return null;
  const start = toInstant(e.start);
  return { start, end: e.end ? toInstant(e.end) : start };
}
