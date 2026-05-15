import type { Bot } from '@maxhub/max-bot-api'

import { logger } from '../utils/logger'
import { channelNotifyLinkStore } from './channelNotifyLinkStore'
import { channelRegistry } from './channelRegistry'
import { clearAdminJoinNotifiedForChannel } from './channelAdminJoinNotified'
import { commentStore } from './commentStore'
import {
  collectAdminNotifyRecipientIds,
  deliverAdminNotifications,
} from './notificationService'
import { postStore } from './postStore'
import { stateManager } from './stateManager'

export type ChannelFullDisconnectReason =
  | 'removed_from_chat'
  | 'lost_admin_rights'
  | 'manual_admin_panel'
  /** Реестр устарел: getChat не проходит, уведомления не шлём. */
  | 'registry_stale_removed'

/**
 * Removes all bot-side data for a registered channel (registry, posts, comments, notify links)
 * and optionally notifies channel admins in DM before links are dropped.
 */
export async function fullyDisconnectRegisteredChannel(
  bot: Bot,
  chatId: number,
  reason: ChannelFullDisconnectReason,
): Promise<boolean> {
  const reg = channelRegistry.getChannel(chatId)
  if (!reg) {
    logger.info('channelFullDisconnect: channel not in registry, skipping', { chatId, reason })
    return false
  }

  const displayTitle = reg.title?.trim() || 'без названия'
  const shouldNotify =
    reason !== 'manual_admin_panel' && reason !== 'registry_stale_removed'

  let recipientIds: number[] = []
  if (shouldNotify) {
    try {
      recipientIds = await collectAdminNotifyRecipientIds(bot, chatId)
    } catch (err: unknown) {
      logger.warn('channelFullDisconnect: collect recipients failed', { chatId, err })
    }
  }

  stateManager.clearChannelPendingAdminRights(chatId)
  clearAdminJoinNotifiedForChannel(chatId)
  channelNotifyLinkStore.removeAllForChannel(chatId)
  const postIds = postStore.removePostsForChatId(chatId)
  commentStore.removeCommentsByPostIds(new Set(postIds))
  channelRegistry.removeChannel(chatId)

  try {
    await channelNotifyLinkStore.forcePersist()
  } catch (err: unknown) {
    logger.warn('channelFullDisconnect: forcePersist notify links failed', { chatId, err })
  }

  if (shouldNotify && recipientIds.length > 0) {
    const reasonBlock =
      reason === 'lost_admin_rights'
        ? 'С бота сняли права администратора в канале. Без них CommentBot не может показывать кнопки комментариев и обрабатывать обсуждения.\n\nКанал отключён: посты и комментарии из базы удалены, связь с каналом сброшена.\n\nЧтобы снова включить комментарии, добавьте бота заново и выдайте права администратора.'
        : 'Бот удалён из канала или потерял к нему доступ.\n\nКанал отключён: посты и комментарии из базы удалены, связь с каналом сброшена.'

    const message =
      `🔌 CommentBot отключён\n` +
      `Канал: «${displayTitle}»\n` +
      `ID чата: ${chatId}\n\n` +
      reasonBlock

    await deliverAdminNotifications(bot, chatId, recipientIds, message)
  }

  logger.info('channelFullDisconnect: completed', { chatId, reason, notified: shouldNotify })
  return true
}

/**
 * Удаляет из реестра каналы типа `channel`, для которых {@link Bot.api.getChat} больше не проходит
 * (бот выгнан, чат удалён и т.п.), чтобы админка и поллер не показывали «мёртвые» записи.
 */
export async function pruneRegisteredChannelsNotAccessibleByBot(bot: Bot): Promise<void> {
  const snapshot = [...channelRegistry.getAllChannels()].filter((c) => c.type === 'channel')
  for (const c of snapshot) {
    if (channelRegistry.getChannel(c.chat_id) === null) {
      continue
    }
    try {
      await bot.api.getChat(c.chat_id)
    } catch (err: unknown) {
      logger.warn('pruneRegisteredChannelsNotAccessibleByBot: getChat failed, removing', {
        chatId: c.chat_id,
        err,
      })
      await fullyDisconnectRegisteredChannel(bot, c.chat_id, 'registry_stale_removed')
    }
  }
}
