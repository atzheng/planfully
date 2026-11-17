import type { Location } from '@planfully/shared';
import type { Env } from '../env';

// Google Places API (New) Text Search. One endpoint covers both venue names and street
// addresses; the Geocoding API only handles addresses. The key goes in X-Goog-Api-Key,
// never in the URL, and the field mask limits the response (and billing) to what we use.
const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.types';
const TIMEOUT_MS = 4000;

export interface PlaceResult {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
}

/**
 * Types that mean "a region, not a spot". Text Search has no partial-match flag, so a
 * query like "the hotel" resolving to a city or country is treated as a weak match.
 */
const COARSE_TYPES = new Set([
  'country',
  'locality',
  'postal_town',
  'postal_code',
  'political',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'sublocality',
  'sublocality_level_1',
  'neighborhood',
  'continent',
]);

/** Weak = no usable coordinates or id, or every type is a coarse region type. */
export function isWeakMatch(p: PlaceResult): boolean {
  const { latitude, longitude } = p.location ?? {};
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || !p.id) return true;
  const types = p.types ?? [];
  return types.length > 0 && types.every((t) => COARSE_TYPES.has(t));
}

export function toLocation(p: PlaceResult): Location {
  const loc: Location = {};
  if (p.displayName?.text) loc.name = p.displayName.text;
  if (p.formattedAddress) loc.address = p.formattedAddress;
  if (p.location?.latitude !== undefined) loc.lat = p.location.latitude;
  if (p.location?.longitude !== undefined) loc.lng = p.location.longitude;
  if (p.id) loc.placeId = p.id;
  return loc;
}

/**
 * Per-ingest-run state. Once Google answers 403 or 429 (key rejected or quota spent) every
 * further lookup in the run would fail the same way, so `blocked` short-circuits them.
 */
export interface GeocodeSession {
  blocked?: boolean;
  /** Bias for name-only lookups, derived from other located events in the run. */
  bias?: GeoBias;
}

/** Places Text Search `locationBias.circle`; radius in metres (API max 50000). */
export interface GeoBias {
  latitude: number;
  longitude: number;
  radius: number;
}

const MAX_BIAS_RADIUS_M = 50_000;
const MIN_BIAS_RADIUS_M = 25_000;
const EARTH_RADIUS_M = 6_371_000;

function distanceM(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad;
  const dLng = (b[1] - a[1]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Pure. Centroid of [lat, lng] points (mean of unit vectors, so antimeridian-safe) with a
 * radius that covers the spread (x1.2), clamped to 25 km..50 km (Google's maximum; a wider
 * spread just means a best-effort bias). Invalid points are ignored; undefined if none left.
 */
export function computeBias(points: Array<[number, number]>): GeoBias | undefined {
  const pts = points.filter(
    ([la, ln]) =>
      Number.isFinite(la) && Number.isFinite(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180,
  );
  if (pts.length === 0) return undefined;
  const rad = Math.PI / 180;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const [la, ln] of pts) {
    x += Math.cos(la * rad) * Math.cos(ln * rad);
    y += Math.cos(la * rad) * Math.sin(ln * rad);
    z += Math.sin(la * rad);
  }
  const n = pts.length;
  const centre: [number, number] = [
    Math.atan2(z / n, Math.hypot(x / n, y / n)) / rad,
    Math.atan2(y / n, x / n) / rad,
  ];
  const spread = Math.max(...pts.map((p) => distanceM(centre, p)));
  const radius = Math.min(MAX_BIAS_RADIUS_M, Math.max(MIN_BIAS_RADIUS_M, Math.round(spread * 1.2)));
  return { latitude: centre[0], longitude: centre[1], radius };
}

/** Generic words that must not make two names "match" on their own. */
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'and',
  'at',
  'hotel',
  'inn',
  'cafe',
  'restaurant',
  'bar',
  'hostel',
  'de',
  'la',
  'le',
  'les',
  'el',
  'los',
  'las',
  'del',
  'des',
  'du',
  'et',
  'y',
  'e',
  'il',
  'lo',
  'der',
  'die',
  'das',
  'und',
  'von',
  'het',
  'van',
  'en',
  'da',
  'do',
  'dos',
  'das',
  'hotell',
  'albergo',
  'ristorante',
  'restaurante',
  'restaurant',
  'gasthaus',
  'cafeteria',
]);

/** Lowercased, accent- and mark-stripped letter/digit tokens (any script). */
function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/**
 * True when the names share at least one non-stopword token. Names with only stopwords
 * ("the hotel") never match: there is nothing distinctive to compare. Scripts written
 * without spaces (Han, kana, Thai) also match when a 3+ character token of one name is
 * contained in the other.
 */
export function namesOverlap(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  const setB = new Set(tb);
  if (ta.some((t) => setB.has(t))) return true;
  const na = normalize(a);
  const nb = normalize(b);
  const contained = (ts: string[], other: string) =>
    ts.some((t) => t.length >= 3 && UNSPACED.test(t) && other.includes(t));
  return contained(ta, nb) || contained(tb, na);
}

/**
 * Returns up to `limit` places, or [] with no key, empty query or any upstream error.
 * A 403/429 logs the status code only (never the query, address or key) and marks the session blocked.
 */
export async function searchPlaces(
  env: Env,
  query: string,
  limit = 5,
  session?: GeocodeSession,
  bias?: GeoBias,
): Promise<PlaceResult[]> {
  const q = query.trim();
  if (!env.GOOGLE_MAPS_SERVER_KEY || !q || session?.blocked) return [];
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': env.GOOGLE_MAPS_SERVER_KEY,
        'x-goog-fieldmask': FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: q,
        pageSize: limit,
        ...(bias && {
          locationBias: {
            circle: {
              center: { latitude: bias.latitude, longitude: bias.longitude },
              radius: bias.radius,
            },
          },
        }),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Network error or timeout: every later lookup would likely burn the timeout too.
    // Never log: the error may carry the query.
    if (session) session.blocked = true;
    return [];
  }
  try {
    if (!res.ok) {
      if (res.status === 403 || res.status === 429) {
        if (session) session.blocked = true;
        console.warn(`geocode: Google Places returned ${res.status} (key rejected or quota)`);
      } else {
        console.warn(`geocode: Google Places returned ${res.status}`);
      }
      return [];
    }
    const data = (await res.json()) as { places?: PlaceResult[] };
    return Array.isArray(data.places) ? data.places.slice(0, limit) : [];
  } catch {
    // Never log: the error may carry the query. Geocoding must never fail ingest.
    return [];
  }
}

/**
 * Fills lat/lng/placeId (and address if missing) from the best match. Fields the caller
 * already has are kept. Both coordinates present: returned unchanged, no lookup. Only one
 * present: it is treated as missing (a lone lat or lng is unusable) and both are replaced
 * by the match, or both dropped when there is no usable match. With no address, a match
 * is accepted only if its name shares a token with the event's location name, so a bare
 * "Hilton" cannot resolve to an unrelated first worldwide hit. Returns the input (minus any lone
 * lat/lng) when there is no key, no query, the upstream fails, or the match is weak.
 */
export async function geocode(
  env: Env,
  loc: Location,
  session?: GeocodeSession,
): Promise<Location> {
  if (loc.lat !== undefined && loc.lng !== undefined) return loc;
  const { lat: _lat, lng: _lng, ...rest } = loc;
  const partial = loc.lat !== undefined || loc.lng !== undefined;
  const base: Location = partial ? rest : loc;
  if (!env.GOOGLE_MAPS_SERVER_KEY) return base;
  const name = loc.name?.trim();
  const address = loc.address?.trim();
  const query = [name, address].filter(Boolean).join(', ');
  if (!query) return base;
  const [best] = await searchPlaces(env, query, 1, session, address ? undefined : session?.bias);
  if (!best || isWeakMatch(best)) return base;
  if (!address && name && !namesOverlap(name, best.displayName?.text ?? '')) return base;
  const found = toLocation(best);
  return {
    ...rest,
    lat: found.lat,
    lng: found.lng,
    placeId: loc.placeId ?? found.placeId,
    address: loc.address ?? found.address,
  };
}
