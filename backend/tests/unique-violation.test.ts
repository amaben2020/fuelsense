import { describe, it, expect } from '@jest/globals'
import { isUniqueViolation } from '../src/lib/errors'

// Drizzle wraps driver errors, so the Postgres error carrying `code` sits on
// `cause`. Reading `.code` off the thrown error never matched, and the
// maintenance route fell through to a generic 500 that echoed the whole query
// and its bind parameters to the client.
describe('isUniqueViolation', () => {
  it('finds the constraint code on a drizzle-wrapped error', () => {
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
    })
    const wrapped = new Error('Failed query: insert into "maintenance_schedules" ...', {
      cause: pgError,
    })

    expect(isUniqueViolation(wrapped)).toBe(true)
  })

  it('finds it on the error itself when the driver error is not wrapped', () => {
    expect(isUniqueViolation(Object.assign(new Error('dup'), { code: '23505' }))).toBe(true)
  })

  it('leaves other failures alone', () => {
    expect(isUniqueViolation(new Error('connection terminated'))).toBe(false)
    expect(isUniqueViolation(Object.assign(new Error('bad input'), { code: '22P02' }))).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
  })

  it('does not spin on a self-referencing cause chain', () => {
    const looping = new Error('boom') as Error & { cause?: unknown }
    looping.cause = looping

    expect(isUniqueViolation(looping)).toBe(false)
  })
})
