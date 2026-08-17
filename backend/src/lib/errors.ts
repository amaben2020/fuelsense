import { Response } from 'express';

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
