import type { Bot } from '@maxhub/max-bot-api'
import type { ChatMember } from '@maxhub/max-bot-api/types'

import { stateManager } from '../services/stateManager'
import { logger } from './logger'

const BATCH_SIZE = 50

export function extractMemberAvatarUrl(
  member: Pick<ChatMember, 'avatar_url' | 'full_avatar_url'> | undefined,
): string | null {
  if (!member) {
    return null
  }
  const raw = member.full_avatar_url ?? member.avatar_url
  if (typeof raw !== 'string') {
    return null
  }
  const trimmed = raw.trim()
  return trimmed || null
}

async function fetchMemberAvatarUrlsInChat(
  bot: Bot,
  chatId: number,
  userIds: number[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const unique = [...new Set(userIds.filter((id) => id > 0))]
  if (unique.length === 0) {
    return out
  }

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE)
    try {
      const { members } = await bot.api.getChatMembers(chatId, { user_ids: chunk })
      for (const m of members) {
        const url = extractMemberAvatarUrl(m)
        if (url) {
          out.set(m.user_id, url)
        }
      }
    } catch (err: unknown) {
      logger.warn('fetchMemberAvatarUrlsInChat: getChatMembers failed', { chatId, err })
    }
  }
  return out
}

/**
 * Resolves profile photo URLs for users via channel membership, then private dialog fallback.
 */
export async function resolveMemberAvatarUrls(
  bot: Bot,
  channelChatId: number,
  userIds: number[],
): Promise<Map<number, string>> {
  const out = await fetchMemberAvatarUrlsInChat(bot, channelChatId, userIds)
  const missing = [...new Set(userIds.filter((id) => id > 0 && !out.has(id)))]
  for (const userId of missing) {
    const priv = stateManager.getUserPrivateChatId(userId)
    if (priv === undefined) {
      continue
    }
    try {
      const { members } = await bot.api.getChatMembers(priv, { user_ids: [userId] })
      const url = extractMemberAvatarUrl(members[0])
      if (url) {
        out.set(userId, url)
      }
    } catch (err: unknown) {
      logger.debug('resolveMemberAvatarUrls: private getChatMembers failed', {
        userId,
        priv,
        err,
      })
    }
  }
  return out
}

/**
 * Display name for a user (e.g. who replied as channel): `name` from channel membership,
 * then from remembered private dialog with the bot.
 */
export async function resolveMemberDisplayName(
  bot: Bot,
  channelChatId: number,
  userId: number,
): Promise<string | null> {
  if (!Number.isFinite(userId) || userId <= 0) {
    return null
  }
  try {
    const { members } = await bot.api.getChatMembers(channelChatId, { user_ids: [userId] })
    const n = members[0]?.name?.trim()
    if (n) {
      return n
    }
  } catch (err: unknown) {
    logger.debug('resolveMemberDisplayName: channel getChatMembers failed', {
      channelChatId,
      userId,
      err,
    })
  }
  const priv = stateManager.getUserPrivateChatId(userId)
  if (priv !== undefined) {
    try {
      const { members } = await bot.api.getChatMembers(priv, { user_ids: [userId] })
      const n = members[0]?.name?.trim()
      if (n) {
        return n
      }
    } catch (err: unknown) {
      logger.debug('resolveMemberDisplayName: private getChatMembers failed', {
        priv,
        userId,
        err,
      })
    }
  }
  return null
}
