import type { Bot } from '@maxhub/max-bot-api'

import { purgeChannelFromAdminState } from '../api/adminPanelState'
import { logger } from '../utils/logger'
import { fetchBotChatMember, isBotAdminOrOwner } from './botChannelMembership'
import { channelNotifyLinkStore } from './channelNotifyLinkStore'
import { channelRegistry } from './channelRegistry'
import { channelSettingsStore } from './channelSettingsStore'
import { clearAdminJoinNotifiedForChannel } from './channelAdminJoinNotified'
import { clearChannelPollerErrors } from './channelPoller'
import { clearCommentButtonRetriesForChannel } from './commentButtonRetryQueue'
import { commentStore } from './commentStore'
import { integrationsStore } from './integrationsStore'
import {
  collectAdminNotifyRecipientIds,
  deliverAdminNotifications,
} from './notificationService'
import { postStore } from './postStore'
import { settingsStore } from './settingsStore'
import { stateManager } from './stateManager'
import { fullyRemoveUserFromBot } from './userAccessCleanup'

export type ChannelFullDisconnectReason =
  | 'removed_from_chat'
  | 'lost_admin_rights'
  | 'manual_admin_panel'
  /** Реестр устарел: getChat не проходит, уведомления не шлём. */
  | 'registry_stale_removed'

export type RegisteredChannelAccess =
  | 'ok'
  | 'chat_unreachable'
  | 'bot_not_in_chat'
  | 'bot_not_admin'

/**
 * Live check: chat exists for the bot and the bot is still a member with admin/owner rights.
 */
export async function resolveRegisteredChannelAccess(
  bot: Bot,
  chatId: number,
): Promise<RegisteredChannelAccess> {
  try {
    await bot.api.getChat(chatId)
  } catch (err: unknown) {
    logger.debug('resolveRegisteredChannelAccess: getChat failed', { chatId, err })
    return 'chat_unreachable'
  }
  const member = await fetchBotChatMember(bot, chatId)
  if (!member) {
    return 'bot_not_in_chat'
  }
  if (!isBotAdminOrOwner(member)) {
    return 'bot_not_admin'
  }
  return 'ok'
}

function collectUsersToResetAfterChannelPurge(chatId: number): number[] {
  const ids = new Set<number>()
  for (const userId of channelNotifyLinkStore.getUserIdsForChannel(chatId)) {
    ids.add(userId)
  }
  for (const userId of stateManager.getUserIdsPendingJoinToChannel(chatId)) {
    ids.add(userId)
  }
  return [...ids]
}

/**
 * Сбрасывает пользователей, у которых не осталось привязок к каналам после удаления этого канала.
 */
function resetUsersOrphanedAfterChannelPurge(candidateUserIds: number[]): void {
  for (const userId of candidateUserIds) {
    if (settingsStore.getLinkedChannels(userId).length > 0) {
      continue
    }
    fullyRemoveUserFromBot(userId)
    logger.info('channelFullDisconnect: user reset after channel purge', { userId })
  }
}

/**
 * Удаляет все локальные данные канала (SQLite, JSON, in-memory), не трогая глобальных подписчиков бота.
 */
export async function purgeAllChannelData(chatId: number): Promise<void> {
  const linkedBefore = collectUsersToResetAfterChannelPurge(chatId)

  stateManager.clearChannelPendingAdminRights(chatId)
  stateManager.clearAllStatesInChat(chatId)
  stateManager.clearPendingAdminJoinsForChannel(chatId)
  clearAdminJoinNotifiedForChannel(chatId)
  clearChannelPollerErrors(chatId)
  clearCommentButtonRetriesForChannel(chatId)

  channelNotifyLinkStore.removeAllForChannel(chatId)
  channelSettingsStore.removeChannel(chatId)

  const postIds = postStore.removePostsForChatId(chatId)
  commentStore.removeCommentsByPostIds(new Set(postIds))
  channelRegistry.removeChannel(chatId)

  try {
    await channelNotifyLinkStore.forcePersist()
  } catch (err: unknown) {
    logger.warn('channelFullDisconnect: forcePersist notify links failed', { chatId, err })
  }

  try {
    await purgeChannelFromAdminState(chatId)
  } catch (err: unknown) {
    logger.warn('channelFullDisconnect: purgeChannelFromAdminState failed', { chatId, err })
  }

  try {
    const flowsRemoved = await integrationsStore.removeFlowsForMaxChatId(chatId)
    if (flowsRemoved > 0) {
      logger.info('channelFullDisconnect: integration flows removed', { chatId, flowsRemoved })
    }
  } catch (err: unknown) {
    logger.warn('channelFullDisconnect: removeFlowsForMaxChatId failed', { chatId, err })
  }

  resetUsersOrphanedAfterChannelPurge(linkedBefore)
  logger.info('channelFullDisconnect: purgeAllChannelData completed', { chatId })
}

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
  const displayTitle = reg?.title?.trim() || 'без названия'
  const shouldNotify = reason !== 'registry_stale_removed'

  let recipientIds: number[] = []
  if (shouldNotify && reg) {
    try {
      recipientIds = await collectAdminNotifyRecipientIds(bot, chatId)
    } catch (err: unknown) {
      logger.warn('channelFullDisconnect: collect recipients failed', { chatId, err })
    }
  }

  if (reason === 'manual_admin_panel') {
    try {
      await bot.api.leaveChat(chatId)
      logger.info('channelFullDisconnect: bot left channel (manual disconnect)', { chatId })
    } catch (err: unknown) {
      logger.warn('channelFullDisconnect: leaveChat failed (manual disconnect)', { chatId, err })
    }
  }

  await purgeAllChannelData(chatId)

  if (shouldNotify && recipientIds.length > 0) {
    const reasonBlock =
      reason === 'manual_admin_panel'
        ? 'Канал отключён вручную через панель SuperAdmin.\n\nCommentBot покинул канал. Все данные канала (посты, комментарии, привязки пользователей) удалены из базы.\n\nЧтобы снова подключить комментарии, добавьте бота в канал заново и выдайте права администратора.'
        : reason === 'lost_admin_rights'
          ? 'С бота сняли права администратора в канале. Без них CommentBot не может показывать кнопки комментариев и обрабатывать обсуждения.\n\nКанал отключён: все данные канала и привязки пользователей удалены из базы.\n\nЧтобы снова включить комментарии, добавьте бота заново и выдайте права администратора.'
          : 'Бот удалён из канала или потерял к нему доступ.\n\nКанал отключён: все данные канала и привязки пользователей удалены из базы.'

    const message =
      `🔌 CommentBot отключён\n` +
      `Канал: «${displayTitle}»\n` +
      `ID чата: ${chatId}\n\n` +
      reasonBlock

    await deliverAdminNotifications(bot, chatId, recipientIds, message)
  }

  if (!reg) {
    logger.info('channelFullDisconnect: channel was not in registry; sidecar data purged', {
      chatId,
      reason,
    })
    return false
  }

  logger.info('channelFullDisconnect: completed', { chatId, reason, notified: shouldNotify })
  return true
}

/**
 * Удаляет из реестра каналы, к которым бот больше не имеет доступа
 * (чат удалён, бот выгнан; без прав админа остаются для статуса «ожидает прав»).
 */
export async function pruneRegisteredChannelsNotAccessibleByBot(bot: Bot): Promise<void> {
  const snapshot = [...channelRegistry.getAllChannels()].filter((c) => c.type === 'channel')
  for (const c of snapshot) {
    if (channelRegistry.getChannel(c.chat_id) === null) {
      continue
    }
    const access = await resolveRegisteredChannelAccess(bot, c.chat_id)
    if (access === 'chat_unreachable') {
      logger.warn('pruneRegisteredChannelsNotAccessibleByBot: chat unreachable, removing', {
        chatId: c.chat_id,
      })
      await fullyDisconnectRegisteredChannel(bot, c.chat_id, 'registry_stale_removed')
      continue
    }
    if (access === 'bot_not_in_chat') {
      logger.warn('pruneRegisteredChannelsNotAccessibleByBot: bot not in chat, removing', {
        chatId: c.chat_id,
      })
      await fullyDisconnectRegisteredChannel(bot, c.chat_id, 'removed_from_chat')
      continue
    }
    if (access === 'ok') {
      stateManager.clearChannelPendingAdminRights(c.chat_id)
    }
  }
}
