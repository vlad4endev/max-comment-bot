import { randomBytes } from 'node:crypto'

import { config } from '../config'
import { getDb } from '../db/database'
import { generateDeeplink } from '../utils/deeplink'
import {
  buildTelegramAccountPairStartPayload,
  buildTelegramBotPairUrl,
  isTelegramAccountPairStartPayload,
  parseTelegramAccountPairToken,
} from '../utils/telegramDeeplink'
import { ownerProfileStore, type OwnerAccountInput, type OwnerPlatform } from './ownerProfileStore'
import { telegramBotUserStore } from './telegramBotUserStore'
import { logger } from '../utils/logger'

const PAIRING_TTL_MINUTES = 30
const BOT_USERNAME = 'commentvmax_bot'

export interface AccountPairingStatusWire {
  profile_id: string | null
  max_linked: boolean
  telegram_linked: boolean
  max_account: {
    user_id: number
    username: string | null
    name: string | null
  } | null
  telegram_account: {
    user_id: number
    username: string | null
    name: string | null
  } | null
}

export interface AccountPairingInviteWire {
  token: string
  invite_url: string
  expires_at: string
  target_platform: 'telegram' | 'max'
}

function generateToken(): string {
  return randomBytes(9).toString('base64url').slice(0, 12)
}

function pairingExpiresAt(): string {
  return new Date(Date.now() + PAIRING_TTL_MINUTES * 60_000).toISOString()
}

function accountDisplayName(
  username: string | null,
  firstName: string | null,
  lastName: string | null,
  userId: number,
): string | null {
  const full = [firstName, lastName].filter(Boolean).join(' ').trim()
  if (full) {
    return full
  }
  if (username) {
    return username.startsWith('@') ? username : `@${username}`
  }
  return `ID ${userId}`
}

export function getAccountPairingStatus(
  platform: OwnerPlatform,
  userId: number,
): AccountPairingStatusWire {
  const profileId = ownerProfileStore.getProfileId(platform, userId)
  if (!profileId) {
    return {
      profile_id: null,
      max_linked: false,
      telegram_linked: false,
      max_account: null,
      telegram_account: null,
    }
  }
  const accounts = ownerProfileStore.getAccountsForProfile(profileId)
  const maxAcc = accounts.find((a) => a.platform === 'max')
  const tgAcc = accounts.find((a) => a.platform === 'telegram')
  const maxUserId = maxAcc ? Number.parseInt(maxAcc.platform_user_id, 10) : Number.NaN
  const tgUserId = tgAcc ? Number.parseInt(tgAcc.platform_user_id, 10) : Number.NaN
  return {
    profile_id: profileId,
    max_linked: !!(maxAcc && Number.isInteger(maxUserId) && maxUserId > 0),
    telegram_linked: !!(tgAcc && Number.isInteger(tgUserId) && tgUserId > 0),
    max_account:
      maxAcc && Number.isInteger(maxUserId) && maxUserId > 0
        ? {
            user_id: maxUserId,
            username: maxAcc.username,
            name: accountDisplayName(maxAcc.username, maxAcc.first_name, maxAcc.last_name, maxUserId),
          }
        : null,
    telegram_account:
      tgAcc && Number.isInteger(tgUserId) && tgUserId > 0
        ? {
            user_id: tgUserId,
            username: tgAcc.username,
            name: accountDisplayName(tgAcc.username, tgAcc.first_name, tgAcc.last_name, tgUserId),
          }
        : null,
  }
}

function assertCanInvitePeer(platform: OwnerPlatform, userId: number, target: 'telegram' | 'max'): void {
  const status = getAccountPairingStatus(platform, userId)
  if (target === 'telegram' && status.telegram_linked) {
    throw new Error('telegram already linked')
  }
  if (target === 'max' && status.max_linked) {
    throw new Error('max already linked')
  }
}

function insertPendingToken(
  token: string,
  profileId: string,
  initiatorPlatform: OwnerPlatform,
  initiatorUserId: number,
): string {
  const expiresAt = pairingExpiresAt()
  getDb()
    .prepare(
      `INSERT INTO account_pairing_tokens (
        token, profile_id, initiator_platform, initiator_user_id, status, expires_at
      ) VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .run(token, profileId, initiatorPlatform, String(initiatorUserId), expiresAt)
  return expiresAt
}

/** MAX-пользователь приглашает привязать Telegram. */
export function createTelegramPairingInvite(account: OwnerAccountInput): AccountPairingInviteWire {
  if (account.platform !== 'max') {
    throw new Error('invalid initiator platform')
  }
  assertCanInvitePeer('max', account.platformUserId, 'telegram')
  const profileId = ownerProfileStore.syncAccount(account)
  const token = generateToken()
  const expiresAt = insertPendingToken(token, profileId, 'max', account.platformUserId)
  const payload = buildTelegramAccountPairStartPayload(token)
  return {
    token,
    invite_url: buildTelegramBotPairUrl(payload),
    expires_at: expiresAt,
    target_platform: 'telegram',
  }
}

/** Telegram-пользователь приглашает привязать MAX. */
export function createMaxPairingInvite(account: OwnerAccountInput): AccountPairingInviteWire {
  if (account.platform !== 'telegram') {
    throw new Error('invalid initiator platform')
  }
  assertCanInvitePeer('telegram', account.platformUserId, 'max')
  const profileId = ownerProfileStore.syncAccount(account)
  const token = generateToken()
  const expiresAt = insertPendingToken(token, profileId, 'telegram', account.platformUserId)
  const payload = `pair_${token}`
  const nick = config.botNickname.trim() || 'commentvmax_bot'
  return {
    token,
    invite_url: generateDeeplink(payload, nick),
    expires_at: expiresAt,
    target_platform: 'max',
  }
}

type PendingTokenRow = {
  token: string
  profile_id: string
  initiator_platform: OwnerPlatform
  initiator_user_id: string
  status: string
  expires_at: string
}

function loadPendingToken(rawPayload: string): PendingTokenRow {
  const token = parseTelegramAccountPairToken(rawPayload)
  if (!token) {
    throw new Error('invalid pairing token')
  }
  const row = getDb()
    .prepare(
      `SELECT token, profile_id, initiator_platform, initiator_user_id, status, expires_at
       FROM account_pairing_tokens WHERE token = ?`,
    )
    .get(token) as PendingTokenRow | undefined
  if (!row) {
    throw new Error('pairing token not found')
  }
  if (row.status === 'completed') {
    throw new Error('pairing token already used')
  }
  const expiresMs = Date.parse(row.expires_at)
  if (row.status === 'expired' || (Number.isFinite(expiresMs) && expiresMs < Date.now())) {
    getDb()
      .prepare(`UPDATE account_pairing_tokens SET status = 'expired' WHERE token = ?`)
      .run(token)
    throw new Error('pairing token expired')
  }
  if (row.initiator_platform !== 'max') {
    throw new Error('pairing token not for telegram completion')
  }
  return row
}

function loadPendingTokenForMax(rawPayload: string): PendingTokenRow {
  const trimmed = String(rawPayload || '').trim()
  const m = /^pair_([A-Za-z0-9_-]{8,24})$/i.exec(trimmed)
  const token = m?.[1]
  if (!token) {
    throw new Error('invalid pairing token')
  }
  const row = getDb()
    .prepare(
      `SELECT token, profile_id, initiator_platform, initiator_user_id, status, expires_at
       FROM account_pairing_tokens WHERE token = ?`,
    )
    .get(token) as PendingTokenRow | undefined
  if (!row) {
    throw new Error('pairing token not found')
  }
  if (row.status === 'completed') {
    throw new Error('pairing token already used')
  }
  const expiresMs = Date.parse(row.expires_at)
  if (row.status === 'expired' || (Number.isFinite(expiresMs) && expiresMs < Date.now())) {
    getDb()
      .prepare(`UPDATE account_pairing_tokens SET status = 'expired' WHERE token = ?`)
      .run(token)
    throw new Error('pairing token expired')
  }
  if (row.initiator_platform !== 'telegram') {
    throw new Error('pairing token not for max completion')
  }
  return row
}

function markTokenCompleted(token: string): void {
  getDb()
    .prepare(
      `UPDATE account_pairing_tokens
       SET status = 'completed', completed_at = datetime('now')
       WHERE token = ?`,
    )
    .run(token)
}

export function completeAccountPairingFromTelegram(
  startPayload: string,
  telegramAccount: OwnerAccountInput,
): { profile_id: string; max_user_id: number | null } {
  if (telegramAccount.platform !== 'telegram') {
    throw new Error('invalid telegram account')
  }
  const row = loadPendingToken(startPayload)
  const initiatorMaxId = Number.parseInt(row.initiator_user_id, 10)
  ownerProfileStore.attachAccountToProfile(row.profile_id, telegramAccount)
  telegramBotUserStore.markStarted({ id: telegramAccount.platformUserId })
  markTokenCompleted(row.token)
  logger.info('accountPairing: telegram linked to max profile', {
    profileId: row.profile_id,
    tgUserId: telegramAccount.platformUserId,
    maxUserId: initiatorMaxId,
  })
  return {
    profile_id: row.profile_id,
    max_user_id: Number.isInteger(initiatorMaxId) && initiatorMaxId > 0 ? initiatorMaxId : null,
  }
}

export function completeAccountPairingFromMax(
  startPayload: string,
  maxAccount: OwnerAccountInput,
): { profile_id: string; tg_user_id: number | null } {
  if (maxAccount.platform !== 'max') {
    throw new Error('invalid max account')
  }
  const row = loadPendingTokenForMax(startPayload)
  const initiatorTgId = Number.parseInt(row.initiator_user_id, 10)
  ownerProfileStore.attachAccountToProfile(row.profile_id, maxAccount)
  markTokenCompleted(row.token)
  logger.info('accountPairing: max linked to telegram profile', {
    profileId: row.profile_id,
    maxUserId: maxAccount.platformUserId,
    tgUserId: initiatorTgId,
  })
  return {
    profile_id: row.profile_id,
    tg_user_id: Number.isInteger(initiatorTgId) && initiatorTgId > 0 ? initiatorTgId : null,
  }
}

export function isAccountPairStartPayload(raw: string): boolean {
  return isTelegramAccountPairStartPayload(raw) || /^pair_[A-Za-z0-9_-]{8,24}$/i.test(String(raw || '').trim())
}

export { BOT_USERNAME as TELEGRAM_PAIRING_BOT_USERNAME }
