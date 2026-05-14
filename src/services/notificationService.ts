import type { Bot } from '@maxhub/max-bot-api'
import { Keyboard } from '@maxhub/max-bot-api'

import { logger } from '../utils/logger'

export interface NotificationData {
  postId: string
  userId: number
  userName: string
  text: string
  /** Чат, откуда пришёл комментарий (для мульти-канального режима) */
  sourceChatId?: number
}

export class NotificationService {
  private readonly bot: Bot
  private readonly adminChatId: number

  constructor(bot: Bot, adminChatId: number) {
    this.bot = bot
    this.adminChatId = adminChatId
  }

  /**
   * Произвольное текстовое сообщение в админский чат (системные уведомления).
   */
  async notifyAdmin(text: string): Promise<void> {
    try {
      await this.bot.api.sendMessageToChat(this.adminChatId, text)
      logger.info('Админ-уведомление отправлено')
    } catch (err) {
      logger.error('Не удалось отправить админ-уведомление', err)
    }
  }

  async notifyNewComment(data: NotificationData): Promise<void> {
    const { postId, userId, userName, text, sourceChatId } = data
    const chatLine =
      sourceChatId !== undefined ? `\nЧат: ID ${sourceChatId}` : ''
    const message = `📝 Новый комментарий
Пост: #${postId}
От: ${userName} (ID: ${userId})${chatLine}
Текст:
${text}`

    const keyboard = Keyboard.inlineKeyboard([
      [Keyboard.button.callback('✉️ Ответить', `reply_${userId}`)],
    ])

    try {
      await this.bot.api.sendMessageToChat(this.adminChatId, message, {
        attachments: [keyboard],
      })
      logger.info('Уведомление отправлено админу', { postId, userId, sourceChatId })
    } catch (err) {
      logger.error('Не удалось отправить уведомление админу о новом комментарии', err)
    }
  }

  async notifyUserAboutReply(userId: number, replyText: string): Promise<void> {
    const message = `💬 На ваш комментарий ответили:\n\n"${replyText}"`

    try {
      await this.bot.api.sendMessageToUser(userId, message)
      logger.info('Пользователю отправлено уведомление об ответе', { userId })
    } catch (err) {
      logger.error('Не удалось отправить пользователю уведомление об ответе', err)
    }
  }
}

export function createNotificationService(
  bot: Bot,
  adminChatId: number,
): NotificationService {
  return new NotificationService(bot, adminChatId)
}
