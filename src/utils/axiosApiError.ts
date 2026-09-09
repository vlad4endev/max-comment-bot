import axios from 'axios'

function pushTrimmed(parts: string[], value: unknown): void {
  if (typeof value !== 'string') {
    return
  }
  const trimmed = value.trim()
  if (trimmed) {
    parts.push(trimmed.slice(0, 400))
  }
}

/**
 * Axios throws "Request failed with status code 400" and hides the API body.
 * Pull Telegram `description` / MAX `code`+`message` so autopost errors are actionable.
 */
export function formatAxiosRequestError(err: unknown): string {
  if (!axios.isAxiosError(err)) {
    return err instanceof Error ? err.message : String(err)
  }

  const status = err.response?.status
  const data = err.response?.data
  const parts: string[] = []

  if (typeof data === 'string') {
    pushTrimmed(parts, data)
  } else if (typeof data === 'object' && data !== null) {
    const rec = data as Record<string, unknown>
    pushTrimmed(parts, rec.description)
    const code = typeof rec.code === 'string' ? rec.code : ''
    const message = typeof rec.message === 'string' ? rec.message : ''
    if (code || message) {
      parts.push([code, message].filter(Boolean).join(': '))
    }
    if (typeof rec.error === 'object' && rec.error !== null) {
      const nested = rec.error as Record<string, unknown>
      pushTrimmed(parts, nested.message)
    }
  }

  if (parts.length === 0) {
    return err.message
  }
  if (typeof status === 'number') {
    return `HTTP ${status}: ${parts.join(' | ')}`
  }
  return parts.join(' | ')
}
