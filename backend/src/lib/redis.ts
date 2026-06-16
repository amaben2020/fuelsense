import { Redis } from '@upstash/redis';

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export function cacheKey(customerId: string, path: string, params = ''): string {
  return `fs:${customerId}:${path}${params ? ':' + params : ''}`;
}

export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<T> {
  try {
    const cached = await redis.get<T>(key);
    if (cached !== null && cached !== undefined) return cached;
  } catch {
    // Redis failure → fall through to DB
  }
  const result = await fn();
  try {
    await redis.set(key, result, { ex: ttlSeconds });
  } catch {
    // non-fatal
  }
  return result;
}

export async function invalidate(customerId: string, ...paths: string[]): Promise<void> {
  try {
    const keys = paths.map((p) => cacheKey(customerId, p));
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    // non-fatal
  }
}

export async function invalidatePrefix(customerId: string, prefix: string): Promise<void> {
  try {
    const pattern = `fs:${customerId}:${prefix}*`;
    let cursor = 0;
    do {
      const [nextCursor, keys] = await redis.scan(cursor, { match: pattern, count: 50 });
      cursor = Number(nextCursor);
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== 0);
  } catch {
    // non-fatal
  }
}
