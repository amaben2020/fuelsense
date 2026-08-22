import { Response } from 'express';

/**
 * True when the failure is a Postgres unique-constraint violation.
 *
 * Drizzle wraps driver errors, so the Postgres error — the one carrying
 * `code` — sits on `cause` rather than on the error thrown. Reading `.code`
 * off the top-level error silently never matches, and the caller falls
 * through to its generic 500 branch, which for `db.execute` means echoing the
 * whole query and its bind parameters to the client.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 5; depth += 1) {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A failed `db.execute(sql\`...\`)` carries the full query text and bind
 * parameters in its message — drizzle formats driver errors as
 * "Failed query: <sql>\nparams: <values>". That's exactly what you want in a
 * server log and exactly what you don't want in an API response: internal
 * query structure, column names, and customer IDs handed to whoever opens
 * the network tab. `logAndRespond` always logs the full error (and its
 * `cause`, where the actual Postgres error — the useful part — usually
 * lives) and only echoes the message to the client when it doesn't look like
 * a raw query dump.
 */
export function logAndRespond(
  res: Response,
  context: string,
  error: unknown,
  fallbackMessage = 'Something went wrong. Please try again.'
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(`[${context}]`, err, (err as { cause?: unknown }).cause ?? '');
  const safe = /^Failed query:/i.test(err.message) ? fallbackMessage : err.message;
  res.status(500).json({ error: safe });
}
