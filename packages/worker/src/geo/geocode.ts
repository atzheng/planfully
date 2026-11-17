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
}

/** Lowercased, accent-stripped alphanumeric tokens of 2+ characters. */
function tokens(s: string): Set<string> {
  return new Set(
    s
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2),
  );
}

/** True when the two names share at least one token. */
export function namesOverlap(a: string, b: string): boolean {
  const tb = tokens(b);
  for (const t of tokens(a)) if (tb.has(t)) return true;
  return false;
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
): Promise<PlaceResult[]> {
  const q = query.trim();
  if (!env.GOOGLE_MAPS_SERVER_KEY || !q || session?.blocked) return [];
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': env.GOOGLE_MAPS_SERVER_KEY,
        'x-goog-fieldmask': FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: q, pageSize: limit }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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
 * "Hilton" cannot resolve to an unrelated first worldwide hit. Returns the input unchanged
 * when there is no key, no query, the upstream fails, or the match is weak.
 */
export async function geocode(
  env: Env,
  loc: Location,
  session?: GeocodeSession,
): Promise<Location> {
  if (!env.GOOGLE_MAPS_SERVER_KEY) return loc;
  if (loc.lat !== undefined && loc.lng !== undefined) return loc;
  const { lat: _lat, lng: _lng, ...rest } = loc;
  const partial = loc.lat !== undefined || loc.lng !== undefined;
  const base: Location = partial ? rest : loc;
  const name = loc.name?.trim();
  const address = loc.address?.trim();
  const query = [name, address].filter(Boolean).join(', ');
  if (!query) return base;
  const [best] = await searchPlaces(env, query, 1, session);
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
