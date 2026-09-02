/**
 * Validates MAX / Telegram Mini App `initData` (HMAC-SHA256, WebAppData).
 * Same algorithm for both platforms; use the corresponding bot token.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Reject initData older than this (seconds). */
const MAX_AUTH_AGE_SEC = 24 * 60 * 60

export interface VerifiedWebAppUser {
  userId: number
  username: string | null
  authDate: number
}

/**
 * Verify raw `initData` query string and return the signed user id.
 * Returns null if missing, malformed, expired, or signature mismatch.
 */
export function verifyWebAppInitData(
  initDataRaw: string | null | undefined,
  botToken: string,
): VerifiedWebAppUser | null {
  const initData = (initDataRaw ?? '').trim()
  const token = botToken.trim()
  if (!initData || !token) {
    return null
  }

  let params: URLSearchParams
  try {
    params = new URLSearchParams(initData)
  } catch {
    return null
  }

  const hash = (params.get('hash') ?? '').trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    return null
  }

  const pairs: string[] = []
  for (const [key, value] of params.entries()) {
    if (key === 'hash') {
      continue
    }
    pairs.push(`${key}=${value}`)
  }
  pairs.sort()
  const dataCheckString = pairs.join('\n')

  const secretKey = createHmac('sha256', 'WebAppData').update(token).digest()
  const computed = createHmac('sha256', secretKey).update(dataCheckString).digest('hex')
  const expectedBuf = Buffer.from(computed, 'utf8')
  const actualBuf = Buffer.from(hash, 'utf8')
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return null
  }

  const authDateRaw = params.get('auth_date')
  const authDate = authDateRaw ? Number.parseInt(authDateRaw, 10) : NaN
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return null
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (authDate > nowSec + 60 || nowSec - authDate > MAX_AUTH_AGE_SEC) {
    return null
  }

  const userJson = params.get('user')
  if (!userJson) {
    return null
  }
  let user: unknown
  try {
    user = JSON.parse(userJson) as unknown
  } catch {
    return null
  }
  if (typeof user !== 'object' || user === null) {
    return null
  }
  const rec = user as Record<string, unknown>
  const idRaw = rec.id ?? rec.user_id
  const userId =
    typeof idRaw === 'number'
      ? idRaw
      : typeof idRaw === 'string' && /^\d+$/.test(idRaw)
        ? Number.parseInt(idRaw, 10)
        : NaN
  if (!Number.isInteger(userId) || userId <= 0) {
    return null
  }

  const username =
    typeof rec.username === 'string' && rec.username.trim() !== ''
      ? rec.username.trim()
      : null

  return { userId, username, authDate }
}
