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

/** Returns up to `limit` places, or [] with no key, empty query or any upstream error. */
export async function searchPlaces(env: Env, query: string, limit = 5): Promise<PlaceResult[]> {
  const q = query.trim();
  if (!env.GOOGLE_MAPS_SERVER_KEY || !q) return [];
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
    if (!res.ok) return [];
    const data = (await res.json()) as { places?: PlaceResult[] };
    return Array.isArray(data.places) ? data.places.slice(0, limit) : [];
  } catch {
    // Never log: the error may carry the query. Geocoding must never fail ingest.
    return [];
  }
}

/**
 * Fills lat/lng/placeId (and address if missing) from the best match. Fields the caller
 * already has are kept. Returns the input unchanged when there is no key, no query, the
 * location already has coordinates, the upstream fails, or the match is weak.
 */
export async function geocode(env: Env, loc: Location): Promise<Location> {
  if (!env.GOOGLE_MAPS_SERVER_KEY) return loc;
  if (loc.lat !== undefined && loc.lng !== undefined) return loc;
  const query = [loc.name, loc.address]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(', ');
  if (!query) return loc;
  const [best] = await searchPlaces(env, query, 1);
  if (!best || isWeakMatch(best)) return loc;
  const found = toLocation(best);
  return {
    ...loc,
    lat: found.lat,
    lng: found.lng,
    placeId: loc.placeId ?? found.placeId,
    address: loc.address ?? found.address,
  };
}
