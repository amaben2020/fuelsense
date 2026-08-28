// Turns raw stop coordinates into something a fleet manager can act on: a full
// street address and, where Google knows the venue, its name and a photo.
//
// Lookups are cached in `place_cache` keyed on rounded coordinates. A fleet
// revisits the same depots, markets and filling stations daily, and Google
// bills per call, so the same stop is only ever resolved once.
import { db, placeCache, eq, sql } from './db-helpers';
import { inArray } from 'drizzle-orm';
import { chargeGoogleCall, GoogleCallKind } from './google-usage';

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
  /** Backend-proxied so the API key never reaches the browser. Street View of
   *  the actual spot where available, otherwise a photo of the nearby venue. */
  photo_url: string | null;
  image_kind: 'street_view' | 'place_photo' | null;
  /** Capture date of the Street View imagery, so a manager can judge how
   *  current the picture is before acting on it. */
  street_view_date: string | null;
}

const geoKeyFor = (lat: number, lng: number): string =>
  `${lat.toFixed(GEO_PRECISION)},${lng.toFixed(GEO_PRECISION)}`;

const photoUrlFor = (ref: string | null): string | null =>
  ref ? `/api/places/photo?ref=${encodeURIComponent(ref)}` : null;

const streetViewUrlFor = (lat: number, lng: number): string =>
  `/api/places/streetview?lat=${lat}&lng=${lng}`;

/** Picks the best available image: the actual kerbside beats a venue stock photo. */
function imageFor(
  lat: number,
  lng: number,
  panoId: string | null,
  photoRef: string | null
): { photo_url: string | null; image_kind: PlaceDetails['image_kind'] } {
  if (panoId) return { photo_url: streetViewUrlFor(lat, lng), image_kind: 'street_view' };
  const photo = photoUrlFor(photoRef);
  return { photo_url: photo, image_kind: photo ? 'place_photo' : null };
}

async function fetchJson(
  url: string,
  kind: GoogleCallKind
): Promise<Record<string, unknown> | null> {
  if (!(await chargeGoogleCall(kind))) return null;

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

// Coordinates that resolved to nothing. Without this, a stop Google cannot
// identify would re-run three billable calls on every single modal open.
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;
const negativeCache = new Map<string, number>();

const isNegativelyCached = (key: string): boolean => {
  const at = negativeCache.get(key);
  if (at == null) return false;
  if (Date.now() - at > NEGATIVE_TTL_MS) {
    negativeCache.delete(key);
    return false;
  }
  return true;
};

// Bounded LRU of already-fetched image bytes. A stop that several managers open
// costs exactly one Street View request, not one per viewer per page load.
const IMAGE_CACHE_MAX = 250;
const imageCache = new Map<string, { body: Buffer; contentType: string }>();

function cacheImage(key: string, value: { body: Buffer; contentType: string }): void {
  if (imageCache.size >= IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
  imageCache.set(key, value);
}

function readImageCache(key: string): { body: Buffer; contentType: string } | undefined {
  const hit = imageCache.get(key);
  if (!hit) return undefined;
  // Refresh recency so hot places survive eviction.
  imageCache.delete(key);
  imageCache.set(key, hit);
  return hit;
}

async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const data = await fetchJson(
    `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${GOOGLE_KEY}`,
    'geocode'
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
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=60&key=${GOOGLE_KEY}`,
    'places_nearby'
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

/** Free metadata call — tells us whether imagery exists before we request the
 *  billable image, and when it was captured. */
async function streetViewMeta(
  lat: number,
  lng: number
): Promise<{ panoId: string | null; date: string | null }> {
  const data = await fetchJson(
    `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${GOOGLE_KEY}`,
    'streetview_meta'
  );
  if (data?.status !== 'OK') return { panoId: null, date: null };
  return {
    panoId: (data.pano_id as string) ?? null,
    date: (data.date as string) ?? null,
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
    image_kind: null,
    street_view_date: null,
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
      street_view_date: cached.streetViewDate,
      ...imageFor(lat, lng, cached.streetViewPanoId, cached.photoReference),
    };
  }

  // Without a key we still return coordinates rather than failing the request —
  // the trip view stays usable, just without addresses.
  if (!GOOGLE_KEY) return base;

  // A spot Google could not identify stays unidentified for a while. Retrying
  // on every modal open would spend three calls each time for the same nothing.
  if (isNegativelyCached(geoKey)) return base;

  const [address, place, pano] = await Promise.all([
    reverseGeocode(lat, lng),
    nearbyPlace(lat, lng),
    streetViewMeta(lat, lng),
  ]);

  // Nothing resolved (offline, quota, bad key). Don't write an empty row — a
  // later request should be able to retry — but hold it in the negative cache
  // so "later" means hours from now, not the next click.
  if (address == null && place.name == null && pano.panoId == null) {
    negativeCache.set(geoKey, Date.now());
    return base;
  }

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
      streetViewPanoId: pano.panoId,
      streetViewDate: pano.date,
      lookedUpAt: sql`NOW()`,
    })
    .onConflictDoNothing();

  return {
    ...base,
    formatted_address: address,
    place_name: place.name,
    place_id: place.placeId,
    street_view_date: pano.date,
    ...imageFor(lat, lng, pano.panoId, place.photoRef),
  };
}

export interface ProxiedImage {
  body: Buffer;
  contentType: string;
  cached: boolean;
}

async function proxyImage(
  cacheKey: string,
  url: string,
  kind: GoogleCallKind
): Promise<ProxiedImage | null> {
  const hit = readImageCache(cacheKey);
  if (hit) return { ...hit, cached: true };

  if (!GOOGLE_KEY) return null;
  if (!(await chargeGoogleCall(kind))) return null;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const value = {
      body: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'image/jpeg',
    };
    cacheImage(cacheKey, value);
    return { ...value, cached: false };
  } catch {
    return null;
  }
}

/**
 * Places photo, but only for a reference we have already stored. Accepting an
 * arbitrary reference would turn this public route into an open, billable
 * proxy onto Google's image API.
 */
export async function fetchPlacePhoto(
  ref: string,
  maxWidth = 480
): Promise<ProxiedImage | null> {
  const [known] = await db
    .select({ geoKey: placeCache.geoKey })
    .from(placeCache)
    .where(eq(placeCache.photoReference, ref))
    .limit(1);
  if (!known) return null;

  return proxyImage(
    `photo:${ref}:${maxWidth}`,
    `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxWidth}&photo_reference=${encodeURIComponent(ref)}&key=${GOOGLE_KEY}`,
    'place_photo'
  );
}

/**
 * Street View of a stop, restricted to coordinates already resolved through the
 * authenticated lookup. Arbitrary coordinates are rejected, so this route can
 * never be used to bill fresh imagery anywhere on earth.
 */
export async function fetchStreetView(
  lat: number,
  lng: number,
  width = 640,
  height = 360
): Promise<ProxiedImage | null> {
  const geoKey = geoKeyFor(lat, lng);
  const [known] = await db
    .select({ pano: placeCache.streetViewPanoId })
    .from(placeCache)
    .where(eq(placeCache.geoKey, geoKey))
    .limit(1);
  if (!known?.pano) return null;

  return proxyImage(
    `sv:${geoKey}:${width}x${height}`,
    `https://maps.googleapis.com/maps/api/streetview?size=${width}x${height}&location=${lat},${lng}&fov=90&key=${GOOGLE_KEY}`,
    'streetview_image'
  );
}

/**
 * Addresses for many points at once, from the cache only.
 *
 * Trip lists show every stop a vehicle made, which is far too many points to
 * resolve live — each miss would be a billable geocode, on a screen a manager
 * opens repeatedly. So this answers from `place_cache` and returns nothing for
 * points nobody has looked at yet. Opening a stop still resolves it properly
 * via `lookupPlace`, which is the one place the spend is justified.
 */
export async function cachedPlaceNames(
  points: Array<{ lat: number; lng: number }>
): Promise<globalThis.Map<string, string>> {
  const named = new globalThis.Map<string, string>();
  if (points.length === 0) return named;

  const keys = [...new Set(points.map((p) => geoKeyFor(p.lat, p.lng)))];

  const rows = await db
    .select({
      geoKey: placeCache.geoKey,
      placeName: placeCache.placeName,
      formattedAddress: placeCache.formattedAddress,
    })
    .from(placeCache)
    .where(inArray(placeCache.geoKey, keys));

  for (const row of rows) {
    // The venue name reads better than a plus-coded address ("Chicken
    // Republic" beats "XJV8+GG, Ado"), so it wins when Google knows one.
    const label = row.placeName ?? shortAddress(row.formattedAddress);
    if (label) named.set(row.geoKey, label);
  }

  return named;
}

/** First two components of a formatted address — street and area, no country. */
function shortAddress(address: string | null): string | null {
  if (!address) return null;
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  return parts.slice(0, 2).join(', ');
}

/** The cache key for a coordinate, so callers can match rows back to points. */
export const placeKeyFor = geoKeyFor;

export interface FuelStation {
  name: string;
  placeId: string | null;
  /** Metres from the queried point to the station Google returned. */
  distanceMeters: number | null;
  /** Proxied through our API, so the key stays server-side. */
  photoUrl: string | null;
}

// One answer per ~11 m cell, kept for a day: filling stations do not move, and
// a vehicle that parks at the same depot every night must not re-bill the
// lookup each time.
const stationCache = new Map<string, { at: number; station: FuelStation | null }>();
const STATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Is there a filling station where this vehicle stopped?
 *
 * The tracker cannot see fuel entering the tank, so the next best evidence
 * that a fill happened is the vehicle standing still on a forecourt. Radius is
 * deliberately tight — a station 200 m up the road is not where it parked.
 */
export async function nearbyFuelStation(lat: number, lng: number): Promise<FuelStation | null> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = stationCache.get(key);
  if (cached && Date.now() - cached.at < STATION_TTL_MS) return cached.station;

  if (!GOOGLE_KEY) return null;

  const data = await fetchJson(
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=120&type=gas_station&key=${GOOGLE_KEY}`,
    'places_nearby'
  );

  // A refused or failed call is not evidence of absence, so it is not cached.
  if (!data) return null;

  const results = data.results as Array<Record<string, unknown>> | undefined;
  const top = results?.[0];
  let station: FuelStation | null = null;

  if (top) {
    const geometry = (top.geometry as Record<string, unknown> | undefined)?.location as
      | { lat: number; lng: number }
      | undefined;
    const photos = top.photos as Array<Record<string, unknown>> | undefined;
    station = {
      name: (top.name as string) ?? 'Filling station',
      placeId: (top.place_id as string) ?? null,
      photoUrl: photoUrlFor((photos?.[0]?.photo_reference as string) ?? null),
      distanceMeters: geometry
        ? Math.round(
            Math.hypot(
              (geometry.lat - lat) * 111_320,
              (geometry.lng - lng) * 111_320 * Math.cos((lat * Math.PI) / 180)
            )
          )
        : null,
    };
  }

  stationCache.set(key, { at: Date.now(), station });
  return station;
}

/**
 * A map of the claim: the receipt's pin and, when known, where the tracker
 * actually put the vehicle.
 *
 * Street View and forecourt photos do not exist everywhere — Google has
 * neither for stretches of the Keffi–Abuja expressway, where this fleet
 * fuels. A map always renders, so evidence never degrades to an empty box.
 */
export function staticMapPath(
  lat: number,
  lng: number,
  fix?: { lat: number; lng: number } | null
): string {
  const params = new URLSearchParams({ lat: lat.toFixed(6), lng: lng.toFixed(6) });
  if (fix) {
    params.set('flat', fix.lat.toFixed(6));
    params.set('flng', fix.lng.toFixed(6));
  }
  return `/api/places/staticmap?${params.toString()}`;
}

export async function fetchStaticMap(
  lat: number,
  lng: number,
  fix?: { lat: number; lng: number } | null
): Promise<ProxiedImage | null> {
  const key = `map:${lat.toFixed(5)},${lng.toFixed(5)}:${fix ? `${fix.lat.toFixed(5)},${fix.lng.toFixed(5)}` : 'solo'}`;

  const markers = [
    `markers=color:red%7Clabel:R%7C${lat},${lng}`,
    fix ? `markers=color:0x00e599%7Clabel:V%7C${fix.lat},${fix.lng}` : '',
  ]
    .filter(Boolean)
    .join('&');

  // No explicit zoom: with two markers Google frames both, which is the point
  // — the manager sees the gap between the claim and the vehicle.
  const zoom = fix ? '' : '&zoom=16';

  return proxyImage(
    key,
    `https://maps.googleapis.com/maps/api/staticmap?size=480x300&scale=2&maptype=roadmap&${markers}${zoom}&key=${GOOGLE_KEY}`,
    'static_map'
  );
}

export interface AddressSuggestion {
  description: string;
  place_id: string;
}

/**
 * Address suggestions for a partial string, biased to Nigeria.
 *
 * Drivers type a forecourt name on a phone at the pump, so the useful answer
 * is a short list of real places rather than a free-text box that accepts
 * anything. Results are cached per query because the same handful of stations
 * recur constantly across a fleet, and Google charges per keystroke otherwise.
 */
const autocompleteCache = new Map<string, { at: number; results: AddressSuggestion[] }>();
const AUTOCOMPLETE_TTL_MS = 12 * 60 * 60 * 1000;

export async function suggestAddresses(query: string): Promise<AddressSuggestion[]> {
  const key = query.trim().toLowerCase();
  if (key.length < 3) return [];

  const cached = autocompleteCache.get(key);
  if (cached && Date.now() - cached.at < AUTOCOMPLETE_TTL_MS) return cached.results;

  if (!(await chargeGoogleCall('places_autocomplete'))) return [];

  const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  url.searchParams.set('input', query);
  url.searchParams.set('components', 'country:ng');
  url.searchParams.set('key', GOOGLE_KEY);

  try {
    const response = await fetch(url.toString());
    const data = (await response.json()) as {
      status?: string;
      predictions?: Array<{ description: string; place_id: string }>;
    };

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.warn('[places] autocomplete returned', data.status);
      return [];
    }

    const results = (data.predictions ?? [])
      .slice(0, 6)
      .map((p) => ({ description: p.description, place_id: p.place_id }));

    autocompleteCache.set(key, { at: Date.now(), results });
    return results;
  } catch (error) {
    console.error('[places] autocomplete failed:', (error as Error).message);
    return [];
  }
}
