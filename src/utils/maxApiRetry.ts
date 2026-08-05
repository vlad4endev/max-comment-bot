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

/**
 * Собирает текст ошибки вместе с `cause` (undici: "fetch failed" → "other side closed").
 */
export function collectErrorText(err: unknown, maxDepth = 4): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; depth < maxDepth && current != null; depth += 1) {
    if (current instanceof Error) {
      if (current.message.trim()) {
        parts.push(current.message.trim())
      }
      const withCode = current as Error & { code?: unknown }
      if (typeof withCode.code === 'string' && withCode.code.trim()) {
        parts.push(withCode.code.trim())
      }
      current = current.cause
      continue
    }
    if (typeof current === 'object') {
      const o = current as Record<string, unknown>
      if (typeof o.message === 'string' && o.message.trim()) {
        parts.push(o.message.trim())
      }
      if (typeof o.code === 'string' && o.code.trim()) {
        parts.push(o.code.trim())
      }
      current = o.cause
      continue
    }
    parts.push(String(current))
    break
  }
  return parts.filter(Boolean).join(' | ')
}

const TRANSIENT_NETWORK_RE =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|socket hang up|network|fetch failed|other side closed|UND_ERR_|aborted|Client network socket disconnected|prematurely closed|TLS connection|EPROTO/i

/** MAX `errors.too-many-chat-messages` and similar send throttling. */
export function isMaxRateLimitError(err: unknown): boolean {
  if (getApiErrorStatus(err) === 429) {
    return true
  }
  return /too-many-chat-messages|too.many.requests|rate.limit/i.test(collectErrorText(err))
}

/** Transient server-side / network errors that are safe to retry (5xx, undici socket drops). */
export function isMaxTransientError(err: unknown): boolean {
  const status = getApiErrorStatus(err)
  if (status !== undefined && status >= 500 && status < 600) {
    return true
  }
  return TRANSIENT_NETWORK_RE.test(collectErrorText(err))
}

export type MaxApiErrorKind = 'rate_limit' | 'transient_network' | 'server_5xx' | 'other'

export type MaxApiErrorSummary = {
  kind: MaxApiErrorKind
  status?: number
  message: string
  cause?: string
  retryable: boolean
}

/** Краткая сводка для логов: тип, HTTP-статус, message + cause. */
export function summarizeMaxApiError(err: unknown): MaxApiErrorSummary {
  const status = getApiErrorStatus(err)
  const message = err instanceof Error ? err.message : String(err ?? 'unknown error')
  let cause: string | undefined
  if (err instanceof Error && err.cause != null) {
    cause = collectErrorText(err.cause, 3) || undefined
  }

  if (isMaxRateLimitError(err)) {
    return { kind: 'rate_limit', status, message, cause, retryable: true }
  }
  if (status !== undefined && status >= 500 && status < 600) {
    return { kind: 'server_5xx', status, message, cause, retryable: true }
  }
  if (isMaxTransientError(err)) {
    return { kind: 'transient_network', status, message, cause, retryable: true }
  }
  return { kind: 'other', status, message, cause, retryable: false }
}

function kindLabel(kind: MaxApiErrorKind): string {
  switch (kind) {
    case 'rate_limit':
      return 'лимит запросов (429)'
    case 'transient_network':
      return 'сеть / обрыв соединения'
    case 'server_5xx':
      return 'ошибка сервера MAX (5xx)'
    default:
      return 'неклассифицированная'
  }
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
      const summary = summarizeMaxApiError(err)
      if (summary.retryable && i < retries - 1) {
        const base = summary.kind === 'rate_limit' ? 2_000 : 500
        const delay = Math.min(2 ** i * base + Math.random() * 500, 30_000)
        logger.warn('MAX API: временная ошибка, повтор запроса', {
          attempt: i + 1,
          maxAttempts: retries,
          retryInMs: Math.round(delay),
          kind: summary.kind,
          kindLabel: kindLabel(summary.kind),
          status: summary.status,
          message: summary.message,
          cause: summary.cause,
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
