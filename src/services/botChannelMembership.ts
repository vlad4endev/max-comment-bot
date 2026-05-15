import type { Bot } from '@maxhub/max-bot-api'
import type { ChatMember } from '@maxhub/max-bot-api/types'

import { logger } from '../utils/logger'

/**
 * Loads the bot's own {@link ChatMember} row in a chat via `GET chats/{id}/members/me`.
 */
export async function fetchBotChatMember(bot: Bot, channelChatId: number): Promise<ChatMember | null> {
  try {
    return await bot.api.getChatMembership(channelChatId)
  } catch (err: unknown) {
    logger.warn('fetchBotChatMember: API error', { channelChatId, err })
    return null
  }
}

/** Whether the bot is allowed to moderate the channel (admin or owner). */
export function isBotAdminOrOwner(member: ChatMember): boolean {
  return member.is_admin || member.is_owner
}
