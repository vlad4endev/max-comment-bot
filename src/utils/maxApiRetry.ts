import { logger } from './logger'

/** HTTP status from MAX API errors (`err.status` on Error or plain objects). */
export function getApiErrorStatus(err: unknown): number | undefined {
  if (err instanceof Error) {
    const extra = err as Error & { status?: unknown }
    if (typeof extra.status === 'number') {
      return extra.status
    }
    const fromMessage = parseStatusFromMessage(extra.message)
    if (fromMessage !== undefined) {
      return fromMessage
    }
  }
  if (typeof err === 'object' && err !== null) {
    const o = err as Record<string, unknown>
    if (typeof o.status === 'number') {
      return o.status
    }
    if (typeof o.message === 'string') {
      const fromMessage = parseStatusFromMessage(o.message)
      if (fromMessage !== undefined) {
        return fromMessage
      }
    }
  }
  return undefined
}

function parseStatusFromMessage(message: string): number | undefined {
  const m = message.match(/^(\d{3}):/)
  if (!m) return undefined
  const code = Number(m[1])
  return Number.isFinite(code) ? code : undefined
}

/** MAX `errors.too-many-chat-messages` and similar send throttling. */
export function isMaxRateLimitError(err: unknown): boolean {
  if (getApiErrorStatus(err) === 429) {
    return true
  }
  if (err instanceof Error) {
    return /too-many-chat-messages|too.many.requests|rate.limit/i.test(err.message)
  }
  return false
}

/** Transient server-side errors that are safe to retry (5xx, network issues). */
export function isMaxTransientError(err: unknown): boolean {
  const status = getApiErrorStatus(err)
  if (status !== undefined && status >= 500 && status < 600) {
    return true
  }
  if (err instanceof Error) {
    return /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network/i.test(err.message)
  }
  return false
}

/**
 * Retries `fn` on MAX API rate limit (HTTP 429) or transient errors with exponential backoff.
 * Default 5 retries for attach operations (large channels hit 429 often).
 */
export async function apiCallWithRetry<T>(fn: () => Promise<T>, retries = 5): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < retries; i += 1) {
    try {
      return await fn()
    } catch (err: unknown) {
      lastErr = err
      const retryable = isMaxRateLimitError(err) || isMaxTransientError(err)
      if (retryable && i < retries - 1) {
        const base = isMaxRateLimitError(err) ? 2_000 : 500
        const delay = Math.min(2 ** i * base + Math.random() * 500, 30_000)
        logger.warn(`MAX API retryable error, attempt ${i + 1}/${retries} in ${Math.round(delay)}ms`, {
          status: getApiErrorStatus(err),
          message: err instanceof Error ? err.message : String(err),
        })
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
