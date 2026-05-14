import type { Bot } from '@maxhub/max-bot-api'
import { Keyboard } from '@maxhub/max-bot-api'

import { logger } from '../utils/logger'

export interface NotificationData {
  postId: string
  userId: number
  userName: string
  text: string
}

export class NotificationService {
  private readonly bot: Bot
  private readonly adminChatId: number

  constructor(bot: Bot, adminChatId: number) {
    this.bot = bot
    this.adminChatId = adminChatId
  }

  async notifyNewComment(data: NotificationData): Promise<void> {
    const { postId, userId, userName, text } = data
    const message = `📝 **Новый комментарий!**
Пост: #${postId}
От: @${userName} (ID: ${userId})
Текст: "${text}"`

    const keyboard = Keyboard.inlineKeyboard([
      [Keyboard.button.callback('✉️ Ответить', `reply_${userId}`)],
    ])

    try {
      await this.bot.api.sendMessageToChat(this.adminChatId, message, {
        format: 'markdown',
        attachments: [keyboard],
      })
      logger.info('Уведомление отправлено админу', { postId, userId })
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
