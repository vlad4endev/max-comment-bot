import type { Bot } from '@maxhub/max-bot-api'
import { Keyboard } from '@maxhub/max-bot-api'
import type { ChatMember } from '@maxhub/max-bot-api/types'

import { config } from '../config'
import { channelNotifyLinkStore } from './channelNotifyLinkStore'
import { commentStore } from './commentStore'
import { subscriberStore } from './subscriberStore'
import { buildMiniAppUrl, isMiniAppOpenUrlConfigured } from './postStore'
import { stateManager } from './stateManager'
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

function parseNotifyUserId(value: number): number | null {
  const userId = Number(value)
  if (!Number.isInteger(userId) || userId <= 0) {
    return null
  }
  return userId
}

/** Extract MAX API error fields for logs (status / response body when present). */
function loggableApiError(err: unknown): {
  error: string
  errorCode?: number
  errorResponse?: unknown
} {
  if (err instanceof Error) {
    const extra = err as Error & { status?: unknown; response?: unknown }
    return {
      error: err.message,
      errorCode: typeof extra.status === 'number' ? extra.status : undefined,
      errorResponse: extra.response,
    }
  }
  if (typeof err === 'object' && err !== null) {
    const o = err as Record<string, unknown>
    const msg =
      typeof o.message === 'string'
        ? o.message
        : typeof o.error === 'string'
          ? o.error
          : String(err)
    return {
      error: msg,
      errorCode: typeof o.status === 'number' ? o.status : undefined,
      errorResponse: o.response,
    }
  }
  return { error: String(err) }
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

/** MAX: нет личного диалога с пользователем (часто не нажали /start боту). */
function isDialogNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false
  }
  const o = err as { status?: number; response?: { code?: unknown } }
  if (o.status !== 404) {
    return false
  }
  const code = o.response && typeof o.response === 'object' ? (o.response as { code?: unknown }).code : undefined
  return code === 'dialog.not.found'
}

/**
 * Личка админу: сначала {@link Bot.api.sendMessageToUser}; при `dialog.not.found` — повтор в сохранённый
 * приватный чат (`stateManager`), если пользователь уже открывал бота.
 */
async function sendAdminDirectMessage(
  bot: Bot,
  recipientId: number,
  message: string,
  extra?: SendMessageExtra,
): Promise<{ body: { mid: string } }> {
  if (isFallbackAdminChatRecipient(recipientId)) {
    return bot.api.sendMessageToChat(config.ADMIN_CHAT_ID, message, extra)
  }
  try {
    return await bot.api.sendMessageToUser(recipientId, message, extra)
  } catch (firstErr) {
    if (!isDialogNotFoundError(firstErr)) {
      throw firstErr
    }
    const privateChatId = stateManager.getUserPrivateChatId(recipientId)
    if (privateChatId === undefined) {
      throw firstErr
    }
    try {
      const sent = await bot.api.sendMessageToChat(privateChatId, message, extra)
      return sent
    } catch {
      throw firstErr
    }
  }
}

export async function deliverAdminNotifications(
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
      const sent = await sendAdminDirectMessage(bot, recipientId, message, extra)
      out.push({ admin_id: recipientId, message_mid: sent.body.mid })
      logger.info('Уведомление админу доставлено', { recipientId, sourceChat: sourceChatId })
    } catch (err) {
      if (isDialogNotFoundError(err)) {
        logger.debug(
          'Не удалось отправить уведомление админу: нет диалога с ботом (нужен /start в личке с ботом)',
          {
            recipientId,
            sourceChat: sourceChatId,
            ...loggableApiError(err),
          },
        )
      } else {
        logger.warn('Не удалось отправить уведомление админу (пропускаем и идём дальше)', {
          recipientId,
          sourceChat: sourceChatId,
          err,
        })
      }
    }
  }
  return out
}

/**
 * Кто получает DM: сначала явно подключившиеся через invite, плюс админы/владельцы из API.
 */
export async function collectAdminNotifyRecipientIds(bot: Bot, channelChatId: number): Promise<number[]> {
  const recipients = new Set<number>()
  const linked = channelNotifyLinkStore.getUserIdsForChannel(channelChatId)
  for (const userId of linked) {
    recipients.add(userId)
  }
  const admins = await getChannelAdmins(bot, channelChatId)
  for (const userId of admins) {
    recipients.add(userId)
  }
  logger.info('notifyAllAdmins: recipients', {
    chatId: channelChatId,
    linked,
    total: recipients.size,
  })
  return [...recipients]
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
  const recipients = await collectAdminNotifyRecipientIds(bot, chatId)
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
    commentPhotoUrls?: string[]
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
  const textPart = input.commentText.trim()
  const photoCount = Array.isArray(input.commentPhotoUrls) ? input.commentPhotoUrls.length : 0
  const commentPreview =
    textPart !== ''
      ? textPart
      : photoCount > 0
        ? `📷 Фото: ${photoCount}`
        : 'без текста'
  const photoSuffix = photoCount > 0 ? `\n📷 Фото: ${photoCount}` : ''
  const message = `📌 Новый комментарий
Пост: «${postExcerpt}»
Канал: ${input.channelTitle}
👤 ${input.username}: ${commentPreview}${photoSuffix}`

  commentStore.saveNotificationText(input.commentId, message)

  const recipientIds = await collectAdminNotifyRecipientIds(bot, input.channelChatId)
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
    commentId: string
    postText: string
    userCommentText: string
    adminReplyText: string
    adminReplyPhotoUrls?: string[]
    postId: string
    channelChatId: number
  },
): Promise<void> {
  const userId = parseNotifyUserId(input.userId)
  if (userId === null) {
    logger.warn('notifyUserAboutMiniappReply: invalid userId', {
      userId: input.userId,
      commentId: input.commentId,
    })
    return
  }

  logger.info('notifyUserAboutMiniappReply: attempting', {
    userId,
    commentId: input.commentId,
    isSubscriber: subscriberStore.hasSubscriber(userId),
    commentText: input.userCommentText.slice(0, 50),
  })

  if (!subscriberStore.hasSubscriber(userId)) {
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
  const replyPhotoCount = Array.isArray(input.adminReplyPhotoUrls)
    ? input.adminReplyPhotoUrls.length
    : 0
  const replyBody =
    replyPreview.trim() !== ''
      ? `Ответ канала: ${replyPreview}`
      : replyPhotoCount > 0
        ? `Ответ канала: 📷 Фото (${replyPhotoCount})`
        : 'Ответ канала'
  const photoSuffix = replyPhotoCount > 0 ? `\nФото в ответе: ${replyPhotoCount}` : ''
  const message =
    `💬 Вам ответили на комментарий\n\n` +
    `Пост: «${postPreview}»\n` +
    `Ваш комментарий: «${commentPreview}»\n\n` +
    `${replyBody}${photoSuffix}`

  try {
    await bot.api.sendMessageToUser(userId, message, { attachments: [keyboard] })
    logger.info('notifyUserAboutMiniappReply: delivered', { userId, commentId: input.commentId })
  } catch (err: unknown) {
    const apiErr = loggableApiError(err)
    logger.warn('notifyUserAboutMiniappReply: could not deliver', {
      userId,
      commentId: input.commentId,
      ...apiErr,
    })
  }
}
