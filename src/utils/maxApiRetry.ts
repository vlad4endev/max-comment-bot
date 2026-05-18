import { logger } from './logger'

/** HTTP status from MAX API errors (`err.status` on Error or plain objects). */
export function getApiErrorStatus(err: unknown): number | undefined {
  if (err instanceof Error) {
    const extra = err as Error & { status?: unknown }
    if (typeof extra.status === 'number') {
      return extra.status
    }
  }
  if (typeof err === 'object' && err !== null) {
    const o = err as Record<string, unknown>
    if (typeof o.status === 'number') {
      return o.status
    }
  }
  return undefined
}

/**
 * Retries `fn` on MAX API rate limit (HTTP 429) with exponential backoff.
 */
export async function apiCallWithRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < retries; i += 1) {
    try {
      return await fn()
    } catch (err: unknown) {
      lastErr = err
      if (getApiErrorStatus(err) === 429 && i < retries - 1) {
        const delay = 2 ** i * 1000 + Math.random() * 500
        logger.warn(`MAX API rate limited, retry ${i + 1} in ${Math.round(delay)}ms`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }
      throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Max retries exceeded')
}

/** Alias for {@link apiCallWithRetry} (prompt naming). */
export const withRetry = apiCallWithRetry
