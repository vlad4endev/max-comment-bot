import type { Bot } from '@maxhub/max-bot-api'
import { Keyboard } from '@maxhub/max-bot-api'
import type { ChatMember } from '@maxhub/max-bot-api/types'

import { config } from '../config'
import { buildMiniAppUrl } from './postStore'
import { logger } from '../utils/logger'

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

/**
 * Уведомляет всех админов канала личными сообщениями; для `ADMIN_CHAT_ID` используется `sendMessageToChat` (супер-админ / группа).
 */
export async function notifyAllAdmins(
  bot: Bot,
  chatId: number,
  message: string,
  extra?: SendMessageExtra,
): Promise<void> {
  const recipients = await getChannelAdmins(bot, chatId)
  const unique = [...new Set(recipients)]

  for (const recipientId of unique) {
    try {
      if (isFallbackAdminChatRecipient(recipientId)) {
        await bot.api.sendMessageToChat(config.ADMIN_CHAT_ID, message, extra)
      } else {
        await bot.api.sendMessageToUser(recipientId, message, extra)
      }
      logger.info('Уведомление админу доставлено', { recipientId, sourceChat: chatId })
    } catch (err) {
      logger.warn('Не удалось отправить уведомление админу (пропускаем и идём дальше)', {
        recipientId,
        sourceChat: chatId,
        err,
      })
    }
  }
}

/**
 * Уведомляет админов канала о новом комментарии из Mini App (текст + ссылка на приложение с admin=1).
 */
export async function notifyAdminsNewMiniappComment(
  bot: Bot,
  input: {
    channelChatId: number
    postText: string
    channelTitle: string
    username: string
    commentText: string
    postId: string
  },
): Promise<void> {
  const base = config.miniAppUrl
  if (!base) {
    logger.warn('notifyAdminsNewMiniappComment: MINI_APP_URL not set')
    return
  }
  const openUrl = buildMiniAppUrl(base, input.postId, input.channelChatId, { admin: '1' })
  const keyboard = Keyboard.inlineKeyboard([
    [Keyboard.button.link('💬 Открыть комментарии', openUrl)],
  ])
  const postExcerpt = preview80(input.postText)
  const message = `📌 Новый комментарий
Пост: «${postExcerpt}»
Канал: ${input.channelTitle}
👤 ${input.username}: ${input.commentText}`

  await notifyAllAdmins(bot, input.channelChatId, message, {
    attachments: [keyboard],
  })
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
  const base = config.miniAppUrl
  if (!base) {
    logger.warn('notifyUserAboutMiniappReply: MINI_APP_URL not set')
    return
  }
  const openUrl = buildMiniAppUrl(base, input.postId, input.channelChatId)
  const keyboard = Keyboard.inlineKeyboard([[Keyboard.button.link('Открыть', openUrl)]])
  const postExcerpt = preview80(input.postText)
  const message = `💬 Вам ответили на комментарий
Пост: «${postExcerpt}»
Ваш комментарий: ${input.userCommentText}
Ответ канала: ${input.adminReplyText}`

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
