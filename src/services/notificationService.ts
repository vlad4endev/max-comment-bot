import type { Bot } from '@maxhub/max-bot-api'
import { Keyboard } from '@maxhub/max-bot-api'
import type { ChatMember } from '@maxhub/max-bot-api/types'

import { config } from '../config'
import { channelNotifyLinkStore } from './channelNotifyLinkStore'
import type { Comment } from './commentStore'
import { commentStore } from './commentStore'
import { subscriberStore } from './subscriberStore'
import { buildMiniAppUrl, isMiniAppOpenUrlConfigured, postStore } from './postStore'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
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
  const canonical = resolveCanonicalChannelChatId(chatId) ?? chatId
  const attempts = canonical === chatId ? [canonical] : [canonical, chatId]
  for (const id of attempts) {
    try {
      const { members } = await bot.api.getChatAdmins(id)
      const ids = members.filter(isChannelAdminOrOwner).map((m) => m.user_id)
      const unique = [...new Set(ids)]
      if (unique.length > 0) {
        return unique
      }
    } catch (err) {
      logger.warn('getChannelAdmins: не удалось получить админов', {
        chatId: id,
        err,
      })
    }
  }
  logger.warn('getChannelAdmins: список админов пуст, используем OWNER / ADMIN_CHAT_ID', {
    chatId,
    canonical,
  })
  return [...new Set([config.ownerUserId, config.ADMIN_CHAT_ID].filter((id) => id !== 0))]
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
  if (config.ownerUserId > 0) {
    recipients.add(config.ownerUserId)
  }
  if (config.ADMIN_CHAT_ID !== 0) {
    recipients.add(config.ADMIN_CHAT_ID)
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
  skipUserIds?: ReadonlySet<number>,
): Promise<AdminNotificationSendResult[]> {
  const recipients = (await collectAdminNotifyRecipientIds(bot, chatId)).filter(
    (id) => !skipUserIds?.has(id),
  )
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
  const miniAppReady = isMiniAppOpenUrlConfigured()
  if (!miniAppReady) {
    logger.warn('notifyAdminsNewMiniappComment: BOT_NICKNAME / MINI_APP_URL not set — sending text without Mini App button')
  }
  const extra: SendMessageExtra | undefined = miniAppReady
    ? {
        attachments: [
          Keyboard.inlineKeyboard([
            [
              Keyboard.button.link(
                '💬 Открыть комментарии',
                buildMiniAppUrl(
                  input.postId,
                  input.channelChatId,
                  { admin: '1' },
                  resolveMessageMidForPostId(input.postId),
                ),
              ),
            ],
          ]),
        ],
      }
    : undefined
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
  const sent = await deliverAdminNotifications(
    bot,
    input.channelChatId,
    recipientIds,
    message,
    extra,
  )
  if (recipientIds.length > 0 && sent.length === 0) {
    logger.warn('notifyAdminsNewMiniappComment: no MAX DM delivered', {
      commentId: input.commentId,
      channelChatId: input.channelChatId,
      recipientIds,
    })
  }
  for (const { admin_id, message_mid } of sent) {
    commentStore.saveNotificationMid(input.commentId, admin_id, message_mid)
  }
}

function countChannelReplies(comment: Comment): number {
  if (Array.isArray(comment.replies) && comment.replies.length > 0) {
    return comment.replies.length
  }
  return comment.reply ? 1 : 0
}

function isCommentAnsweredByChannel(comment: Comment): boolean {
  return countChannelReplies(comment) > 0
}

function resolveMessageMidForPostId(postId: string): string | undefined {
  return postStore.getPost(postId)?.message_mid
}

function buildAdminCommentNotificationKeyboard(postId: string, channelChatId: number, answered: boolean) {
  const openUrl = buildMiniAppUrl(postId, channelChatId, { admin: '1' }, resolveMessageMidForPostId(postId))
  const label = answered ? '✅ Отвечено' : '💬 Открыть комментарии'
  return Keyboard.inlineKeyboard([[Keyboard.button.link(label, openUrl)]])
}

/**
 * Текст одного DM админу: исходное «новый комментарий» без изменений.
 * Статус «отвечено» — на инлайн-кнопке после ответа канала.
 */
export function buildAdminCommentNotificationBody(comment: Comment): string | null {
  const base = comment.notification_text?.trim()
  if (!base) {
    return null
  }
  return base
}

/**
 * Обновляет одно и то же уведомление админам о комментарии (дописывает хронологию ответов).
 */
export async function syncAdminCommentNotification(
  bot: Bot,
  comment: Comment,
  postId: string,
  channelChatId: number,
): Promise<void> {
  const body = buildAdminCommentNotificationBody(comment)
  if (!body) {
    logger.warn('syncAdminCommentNotification: missing notification_text', {
      commentId: comment.comment_id,
    })
    return
  }
  const mids = commentStore.getNotificationMids(comment.comment_id)
  if (mids.length === 0) {
    return
  }
  if (!isMiniAppOpenUrlConfigured()) {
    logger.warn('syncAdminCommentNotification: BOT_NICKNAME / MINI_APP_URL not set for Mini App links')
    return
  }
  const answered = isCommentAnsweredByChannel(comment)
  const keyboard = buildAdminCommentNotificationKeyboard(postId, channelChatId, answered)
  for (const { admin_id, message_mid } of mids) {
    try {
      await bot.api.editMessage(message_mid, {
        text: body,
        attachments: [keyboard],
      })
    } catch (e: unknown) {
      logger.warn('syncAdminCommentNotification: editMessage failed', {
        admin_id,
        message_mid,
        commentId: comment.comment_id,
        e,
      })
    }
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
  const openUrl = buildMiniAppUrl(
    input.postId,
    input.channelChatId,
    undefined,
    resolveMessageMidForPostId(input.postId),
  )
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
