// Turns raw stop coordinates into something a fleet manager can act on: a full
// street address and, where Google knows the venue, its name and a photo.
//
// Lookups are cached in `place_cache` keyed on rounded coordinates. A fleet
// revisits the same depots, markets and filling stations daily, and Google
// bills per call, so the same stop is only ever resolved once.
import { db, placeCache, eq, sql } from './db-helpers';

const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
// ~11 m of precision. Tighter than this and GPS wander at the same building
// produces cache misses; looser and neighbouring places collapse together.
const GEO_PRECISION = 4;
const LOOKUP_TIMEOUT_MS = 6000;

export interface PlaceDetails {
  latitude: number;
  longitude: number;
  formatted_address: string | null;
  place_name: string | null;
  place_id: string | null;
  /** Backend-proxied so the API key never reaches the browser. */
  photo_url: string | null;
}

const geoKeyFor = (lat: number, lng: number): string =>
  `${lat.toFixed(GEO_PRECISION)},${lng.toFixed(GEO_PRECISION)}`;

const photoUrlFor = (ref: string | null): string | null =>
  ref ? `/api/places/photo?ref=${encodeURIComponent(ref)}` : null;

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const data = await fetchJson(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_KEY}`
  );
  const results = data?.results as Array<Record<string, unknown>> | undefined;
  return (results?.[0]?.formatted_address as string) ?? null;
}

/** Nearest named venue within a short walk of the stop, if Google knows one. */
async function nearbyPlace(
  lat: number,
  lng: number
): Promise<{ name: string | null; placeId: string | null; photoRef: string | null }> {
  const data = await fetchJson(
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=60&key=${GOOGLE_KEY}`
  );
  const results = data?.results as Array<Record<string, unknown>> | undefined;
  const top = results?.[0];
  if (!top) return { name: null, placeId: null, photoRef: null };
  const photos = top.photos as Array<Record<string, unknown>> | undefined;
  return {
    name: (top.name as string) ?? null,
    placeId: (top.place_id as string) ?? null,
    photoRef: (photos?.[0]?.photo_reference as string) ?? null,
  };
}

export async function lookupPlace(lat: number, lng: number): Promise<PlaceDetails> {
  const geoKey = geoKeyFor(lat, lng);
  const base: PlaceDetails = {
    latitude: lat,
    longitude: lng,
    formatted_address: null,
    place_name: null,
    place_id: null,
    photo_url: null,
  };

  const [cached] = await db
    .select()
    .from(placeCache)
    .where(eq(placeCache.geoKey, geoKey))
    .limit(1);

  if (cached) {
    return {
      ...base,
      formatted_address: cached.formattedAddress,
      place_name: cached.placeName,
      place_id: cached.placeId,
      photo_url: photoUrlFor(cached.photoReference),
    };
  }

  // Without a key we still return coordinates rather than failing the request —
  // the trip view stays usable, just without addresses.
  if (!GOOGLE_KEY) return base;

  const [address, place] = await Promise.all([
    reverseGeocode(lat, lng),
    nearbyPlace(lat, lng),
  ]);

  // Nothing resolved (offline, quota, bad key) — don't poison the cache with
  // an empty row, so a later request can retry.
  if (address == null && place.name == null) return base;

  await db
    .insert(placeCache)
    .values({
      geoKey,
      latitude: lat.toFixed(6),
      longitude: lng.toFixed(6),
      formattedAddress: address,
      placeName: place.name,
      placeId: place.placeId,
      photoReference: place.photoRef,
      lookedUpAt: sql`NOW()`,
    })
    .onConflictDoNothing();

  return {
    ...base,
    formatted_address: address,
    place_name: place.name,
    place_id: place.placeId,
    photo_url: photoUrlFor(place.photoRef),
  };
}

/** Resolves many stops at once, de-duplicating repeat coordinates. */
export async function lookupPlaces(
  coords: Array<{ lat: number; lng: number }>
): Promise<Map<string, PlaceDetails>> {
  const unique = new Map<string, { lat: number; lng: number }>();
  for (const c of coords) unique.set(geoKeyFor(c.lat, c.lng), c);

  const out = new Map<string, PlaceDetails>();
  // Sequential on purpose: a burst of parallel Google calls trips rate limits,
  // and cache hits make the common case fast anyway.
  for (const [key, c] of unique) {
    out.set(key, await lookupPlace(c.lat, c.lng));
  }
  return out;
}

export const placeKeyFor = geoKeyFor;

/** Streams a Places photo through the backend so the key stays server-side. */
export async function fetchPlacePhoto(
  ref: string,
  maxWidth = 480
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  if (!GOOGLE_KEY) return null;
  try {
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxWidth}&photo_reference=${encodeURIComponent(ref)}&key=${GOOGLE_KEY}`
    );
    if (!res.ok) return null;
    return {
      body: await res.arrayBuffer(),
      contentType: res.headers.get('content-type') ?? 'image/jpeg',
    };
  } catch {
    return null;
  }
}
