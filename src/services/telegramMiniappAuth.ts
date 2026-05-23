import { createHmac, timingSafeEqual } from 'node:crypto'

import { config } from '../config'
import { withTelegramMiniappPlatform } from '../utils/telegramMiniAppUrl'

const AUTH_VERSION = 'v1'
const AUTH_TTL_SEC = 60 * 60 * 24

function authSecret(): string {
  return `${config.BOT_TOKEN}|tg-miniapp-auth|${AUTH_VERSION}`
}

function signValue(value: string): string {
  return createHmac('sha256', authSecret()).update(value, 'utf8').digest('hex')
}

export function buildTelegramMiniappAuth(
  telegramUserId: number,
  maxChatId: number,
): { tg_uid: string; tg_exp: string; tg_sig: string } {
  const exp = Math.floor(Date.now() / 1000) + AUTH_TTL_SEC
  const base = `${AUTH_VERSION}:${telegramUserId}:${maxChatId}:${exp}`
  return {
    tg_uid: String(telegramUserId),
    tg_exp: String(exp),
    tg_sig: signValue(base),
  }
}

export function verifyTelegramMiniappAuth(input: {
  telegramUserId: number
  maxChatId: number
  tgUidRaw: string | null | undefined
  tgExpRaw: string | null | undefined
  tgSigRaw: string | null | undefined
}): boolean {
  const tgUidRaw = (input.tgUidRaw ?? '').trim()
  const tgExpRaw = (input.tgExpRaw ?? '').trim()
  const tgSigRaw = (input.tgSigRaw ?? '').trim().toLowerCase()
  if (!tgUidRaw || !tgExpRaw || !tgSigRaw) {
    return false
  }
  if (!/^\d+$/.test(tgUidRaw) || !/^\d+$/.test(tgExpRaw) || !/^[a-f0-9]{64}$/.test(tgSigRaw)) {
    return false
  }
  if (Number(tgUidRaw) !== input.telegramUserId) {
    return false
  }
  const exp = Number.parseInt(tgExpRaw, 10)
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
    return false
  }
  const expected = signValue(`${AUTH_VERSION}:${input.telegramUserId}:${input.maxChatId}:${exp}`)
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(tgSigRaw, 'utf8')
  if (expectedBuf.length !== actualBuf.length) {
    return false
  }
  return timingSafeEqual(expectedBuf, actualBuf)
}

export function buildTelegramMiniappUrl(input: {
  postId: string
  maxChatId: number
  messageMid?: string
  telegramUserId: number
}): string | null {
  const base = config.miniAppUrl?.trim()
  if (!base) {
    return null
  }
  const url = new URL(base)
  url.searchParams.set('post_id', input.postId)
  url.searchParams.set('chat_id', String(input.maxChatId))
  url.searchParams.set('admin', '1')
  if (input.messageMid && input.messageMid.trim() !== '') {
    url.searchParams.set('message_mid', input.messageMid.trim())
  }
  const auth = buildTelegramMiniappAuth(input.telegramUserId, input.maxChatId)
  url.searchParams.set('tg_uid', auth.tg_uid)
  url.searchParams.set('tg_exp', auth.tg_exp)
  url.searchParams.set('tg_sig', auth.tg_sig)
  return withTelegramMiniappPlatform(url.toString())
}
