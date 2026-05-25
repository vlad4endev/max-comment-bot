import { ensureAdminPanelStateLoaded } from '../api/adminPanelState'
import { buildTelegramBotJoinUrl } from '../utils/telegramDeeplink'
import { listTgChainsForMaxChannel } from './channelCommentsButtonPolicy'
import { profilePairingForPlatformUser } from './channelLinkAdminTeamSync'
import { integrationsStore } from './integrationsStore'
import { listTelegramChatAdministrators } from './integrationPlatformClient'
import { resolveTelegramSourceChannelsForMaxChat } from './telegramAdminNotificationService'
import { telegramBotUserStore } from './telegramBotUserStore'
import { telegramChannelNotifyLinkStore } from './telegramChannelNotifyLinkStore'

function adminDisplayInitials(name: string): string {
  const t = name.trim()
  if (t.length >= 2) {
    const parts = t.split(/\s+/)
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase()
    }
    return t.slice(0, 2).toUpperCase()
  }
  return t.slice(0, 2).toUpperCase() || '?'
}

/** Numeric Telegram chat id linked to this MAX channel (tg_chain or integration flow). */
export function resolvePrimaryTelegramChannelChatIdForMax(maxChatId: number): string | null {
  for (const chain of listTgChainsForMaxChannel(maxChatId)) {
    const id = chain.tg_channel_id?.trim()
    if (id && /^-?\d+$/.test(id)) {
      return id
    }
  }
  for (const source of resolveTelegramSourceChannelsForMaxChat(maxChatId)) {
    const t = source.trim()
    if (/^-?\d+$/.test(t)) {
      return t
    }
  }
  return null
}

/** `jointg…` deep link for TG-only admins of the linked Telegram channel. */
export function buildTelegramNotifyInviteUrlForMaxChannel(maxChatId: number): string | null {
  const tgChatId = resolvePrimaryTelegramChannelChatIdForMax(maxChatId)
  if (!tgChatId) {
    return null
  }
  try {
    return buildTelegramBotJoinUrl(tgChatId)
  } catch {
    return null
  }
}

export interface SupplementalTelegramAdminWire {
  user_id: number
  name: string
  initials: string
  linked: boolean
  paired: boolean
  max_user_id: null
  tg_user_id: number
  peer_platform: 'telegram'
  admin_platform: 'telegram'
}

/**
 * TG channel admins who are not represented as MAX channel admins (colleagues only in Telegram).
 */
export async function listSupplementalTelegramAdminsForMaxChannel(
  maxChatId: number,
  maxAdminUserIds: Set<number>,
  tgToken: string,
): Promise<{ tgChannelChatId: string | null; admins: SupplementalTelegramAdminWire[] }> {
  await ensureAdminPanelStateLoaded()
  await integrationsStore.load()

  const tgChatId = resolvePrimaryTelegramChannelChatIdForMax(maxChatId)
  const token = tgToken.trim()
  if (!tgChatId || token === '') {
    return { tgChannelChatId: null, admins: [] }
  }

  let tgAdmins: Awaited<ReturnType<typeof listTelegramChatAdministrators>>
  try {
    tgAdmins = await listTelegramChatAdministrators(token, tgChatId)
  } catch {
    return { tgChannelChatId: tgChatId, admins: [] }
  }

  const linkedIds = new Set(telegramChannelNotifyLinkStore.getUserIdsForChannel(tgChatId))
  const startedIds = telegramBotUserStore.getStartedIds(tgAdmins.map((a) => a.userId))
  const supplemental: SupplementalTelegramAdminWire[] = []
  const seen = new Set<number>()

  for (const row of tgAdmins) {
    if (seen.has(row.userId)) {
      continue
    }
    seen.add(row.userId)

    const pairing = profilePairingForPlatformUser('telegram', row.userId)
    if (pairing.max_user_id != null && maxAdminUserIds.has(pairing.max_user_id)) {
      continue
    }

    supplemental.push({
      user_id: row.userId,
      name: row.name,
      initials: adminDisplayInitials(row.name),
      linked: linkedIds.has(row.userId) && startedIds.has(row.userId),
      paired: false,
      max_user_id: null,
      tg_user_id: row.userId,
      peer_platform: 'telegram',
      admin_platform: 'telegram',
    })
  }

  return { tgChannelChatId: tgChatId, admins: supplemental }
}
