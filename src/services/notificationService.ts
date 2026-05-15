import type { Bot } from '@maxhub/max-bot-api'
import { Keyboard } from '@maxhub/max-bot-api'
import type { ChatMember } from '@maxhub/max-bot-api/types'

import { config } from '../config'
import { channelNotifyLinkStore } from './channelNotifyLinkStore'
import { commentStore } from './commentStore'
import { subscriberStore } from './subscriberStore'
import { buildMiniAppUrl, isMiniAppOpenUrlConfigured } from './postStore'
import { logger } from '../utils/logger'

export interface AdminNotificationSendResult {
  admin_id: number
  message_mid: string
}

/** Доп. параметры отправки сообщения (клавиатура и т.д.), как у `bot.api.sendMessageToUser`. */
export type SendMessageExtra = NonNullable<Parameters<Bot['api']['sendMessageToUser']>[2]>

function preview80(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  if (t.length <= 80) {
    return t
  }
  return `${t.slice(0, 80)}…`
}

function isChannelAdminOrOwner(member: ChatMember): boolean {
  return !member.is_bot && (member.is_admin || member.is_owner)
}

/**
 * Возвращает user_id админов и владельцев чата (роли в API: {@link ChatMember.is_admin} / {@link ChatMember.is_owner}).
 * Вызывает {@link Bot.api.getChatAdmins} → `GET chats/{chat_id}/members/admins`.
 */
export async function getChannelAdmins(bot: Bot, chatId: number): Promise<number[]> {
  try {
    const { members } = await bot.api.getChatAdmins(chatId)
    const ids = members.filter(isChannelAdminOrOwner).map((m) => m.user_id)
    const unique = [...new Set(ids)]
    if (unique.length === 0) {
      logger.warn('getChannelAdmins: список админов пуст, используем ADMIN_CHAT_ID', {
        chatId,
      })
      return [config.ADMIN_CHAT_ID]
    }
    return unique
  } catch (err) {
    logger.warn('getChannelAdmins: не удалось получить админов, fallback на ADMIN_CHAT_ID', {
      chatId,
      err,
    })
    return [config.ADMIN_CHAT_ID]
  }
}

function isFallbackAdminChatRecipient(recipientId: number): boolean {
  return recipientId === config.ADMIN_CHAT_ID
}

async function deliverAdminNotifications(
  bot: Bot,
  sourceChatId: number,
  recipientIds: number[],
  message: string,
  extra?: SendMessageExtra,
): Promise<AdminNotificationSendResult[]> {
  const unique = [...new Set(recipientIds)]
  const out: AdminNotificationSendResult[] = []

  for (const recipientId of unique) {
    try {
      const sent = isFallbackAdminChatRecipient(recipientId)
        ? await bot.api.sendMessageToChat(config.ADMIN_CHAT_ID, message, extra)
        : await bot.api.sendMessageToUser(recipientId, message, extra)
      out.push({ admin_id: recipientId, message_mid: sent.body.mid })
      logger.info('Уведомление админу доставлено', { recipientId, sourceChat: sourceChatId })
    } catch (err) {
      logger.warn('Не удалось отправить уведомление админу (пропускаем и идём дальше)', {
        recipientId,
        sourceChat: sourceChatId,
        err,
      })
    }
  }
  return out
}

/**
 * Кто получает DM о новом комментарии: явные подписки из мини-приложения, иначе все админы из API.
 */
async function resolveMiniappCommentNotifyRecipientIds(bot: Bot, channelChatId: number): Promise<number[]> {
  const linked = channelNotifyLinkStore.getUserIdsForChannel(channelChatId)
  if (linked.length > 0) {
    return linked
  }
  return getChannelAdmins(bot, channelChatId)
}

/**
 * Уведомляет всех админов канала личными сообщениями; для `ADMIN_CHAT_ID` используется `sendMessageToChat` (супер-админ / группа).
 * Возвращает пары `admin_id` / `message_mid` только для успешно отправленных сообщений.
 */
export async function notifyAllAdmins(
  bot: Bot,
  chatId: number,
  message: string,
  extra?: SendMessageExtra,
): Promise<AdminNotificationSendResult[]> {
  const recipients = await getChannelAdmins(bot, chatId)
  return deliverAdminNotifications(bot, chatId, recipients, message, extra)
}

/**
 * Уведомляет админов канала о новом комментарии из Mini App (текст + ссылка на приложение с admin=1).
 */
export async function notifyAdminsNewMiniappComment(
  bot: Bot,
  input: {
    commentId: string
    channelChatId: number
    postText: string
    channelTitle: string
    username: string
    commentText: string
    postId: string
  },
): Promise<void> {
  if (!isMiniAppOpenUrlConfigured()) {
    logger.warn('notifyAdminsNewMiniappComment: BOT_NICKNAME / MINI_APP_URL not set for Mini App links')
    return
  }
  const openUrl = buildMiniAppUrl(input.postId, input.channelChatId, { admin: '1' })
  const keyboard = Keyboard.inlineKeyboard([
    [Keyboard.button.link('💬 Открыть комментарии', openUrl)],
  ])
  const postExcerpt = preview80(input.postText)
  const message = `📌 Новый комментарий
Пост: «${postExcerpt}»
Канал: ${input.channelTitle}
👤 ${input.username}: ${input.commentText}`

  commentStore.saveNotificationText(input.commentId, message)

  const recipientIds = await resolveMiniappCommentNotifyRecipientIds(bot, input.channelChatId)
  const sent = await deliverAdminNotifications(bot, input.channelChatId, recipientIds, message, {
    attachments: [keyboard],
  })
  for (const { admin_id, message_mid } of sent) {
    commentStore.saveNotificationMid(input.commentId, admin_id, message_mid)
  }
}

/**
 * Шлёт пользователю DM об ответе канала на комментарий (кнопка «Открыть»). Ошибки доставки логируются.
 */
export async function notifyUserAboutMiniappReply(
  bot: Bot,
  input: {
    userId: number
    postText: string
    userCommentText: string
    adminReplyText: string
    postId: string
    channelChatId: number
  },
): Promise<void> {
  if (!subscriberStore.hasSubscriber(input.userId)) {
    return
  }
  if (!isMiniAppOpenUrlConfigured()) {
    logger.warn('notifyUserAboutMiniappReply: BOT_NICKNAME / MINI_APP_URL not set for Mini App links')
    return
  }
  const openUrl = buildMiniAppUrl(input.postId, input.channelChatId)
  const keyboard = Keyboard.inlineKeyboard([[Keyboard.button.link('Открыть', openUrl)]])
  const postPreview = input.postText.slice(0, 60)
  const commentPreview = input.userCommentText.slice(0, 60)
  const replyPreview = input.adminReplyText.slice(0, 80)
  const message =
    `💬 Вам ответили на комментарий\n\n` +
    `Пост: «${postPreview}»\n` +
    `Ваш комментарий: «${commentPreview}»\n\n` +
    `Ответ канала: ${replyPreview}`

  try {
    await bot.api.sendMessageToUser(input.userId, message, { attachments: [keyboard] })
    logger.info('notifyUserAboutMiniappReply: delivered', { userId: input.userId })
  } catch (err: unknown) {
    logger.warn('notifyUserAboutMiniappReply: could not deliver', {
      userId: input.userId,
      err,
    })
  }
}
