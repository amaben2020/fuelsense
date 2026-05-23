export const CACHE_GEOCODE = process.env.CACHE_GEOCODE === 'true';

const cache = new Map<string, string>();

function cacheKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

export function getCachedPlaceName(lat: number, lng: number): string | undefined {
  if (!CACHE_GEOCODE) return undefined;
  return cache.get(cacheKey(lat, lng));
}

export function setCachedPlaceName(lat: number, lng: number, name: string): void {
  if (!CACHE_GEOCODE) return;
  cache.set(cacheKey(lat, lng), name);
}
