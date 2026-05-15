import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** Имя cookie с подписанной сессией панели управления. */
export const ADMIN_PANEL_COOKIE_NAME = 'admin_panel'

const SESSION_VERSION = 1
/** 7 суток */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function secretEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest()
  const hb = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

export function adminPanelCredentialsMatch(
  username: string,
  password: string,
  expectedUser: string,
  expectedPass: string,
): boolean {
  return secretEqual(username, expectedUser) && secretEqual(password, expectedPass)
}

export function signAdminPanelSessionValue(secret: string): string {
  const payloadObj = { v: SESSION_VERSION, iat: Date.now() }
  const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifyAdminPanelSessionValue(secret: string, raw: string | null | undefined): boolean {
  if (raw === null || raw === undefined || raw === '') {
    return false
  }
  const dot = raw.indexOf('.')
  if (dot <= 0) {
    return false
  }
  const payload = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  const expectedSig = createHmac('sha256', secret).update(payload).digest('base64url')
  try {
    const sb = Buffer.from(sig, 'utf8')
    const eb = Buffer.from(expectedSig, 'utf8')
    if (sb.length !== eb.length) {
      return false
    }
    if (!timingSafeEqual(sb, eb)) {
      return false
    }
  } catch {
    return false
  }
  let parsed: { v?: unknown; iat?: unknown }
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      v?: unknown
      iat?: unknown
    }
  } catch {
    return false
  }
  if (parsed.v !== SESSION_VERSION || typeof parsed.iat !== 'number') {
    return false
  }
  if (Date.now() - parsed.iat > SESSION_MAX_AGE_MS) {
    return false
  }
  return true
}

export function adminPanelSessionCookieHeader(
  secret: string,
  maxAgeSec: number,
  secure: boolean,
): string {
  const value = signAdminPanelSessionValue(secret)
  const parts = [
    `${ADMIN_PANEL_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ]
  if (secure) {
    parts.push('Secure')
  }
  return parts.join('; ')
}

export function adminPanelLogoutCookieHeader(secure: boolean): string {
  const parts = [`${ADMIN_PANEL_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0']
  if (secure) {
    parts.push('Secure')
  }
  return parts.join('; ')
}
