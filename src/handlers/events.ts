import { Bot, Context } from '@maxhub/max-bot-api'
import type { ChatType } from '@maxhub/max-bot-api/types'
import type { Message } from '@maxhub/max-bot-api/types'

import { config } from '../config'
import { channelRegistry } from '../services/channelRegistry'
import { commentService } from '../services/commentService'
import { createNotificationService } from '../services/notificationService'
import { stateManager } from '../services/stateManager'
import { parsePayload } from '../utils/deeplink'
import { logger } from '../utils/logger'

/**
 * Определяет идентификатор чата для входящего сообщения (группа/канал/диалог).
 * Если `recipient.chat_id` отсутствует, используется id пользователя как запасной ключ для 1:1.
 */
function resolveMessageChatId(message: Message, fallbackUserId: number): number {
  const rid = message.recipient.chat_id
  if (typeof rid === 'number' && Number.isFinite(rid)) {
    return rid
  }
  return fallbackUserId
}

/**
 * Достаёт chat_id из колбэка (кнопка под сообщением): сначала из контекста, затем из сообщения.
 */
function resolveCallbackChatId(ctx: Context, fallbackUserId: number): number {
  const fromCtx = ctx.chatId
  if (typeof fromCtx === 'number' && Number.isFinite(fromCtx)) {
    return fromCtx
  }
  const msg = ctx.message
  if (msg) {
    return resolveMessageChatId(msg, fallbackUserId)
  }
  return fallbackUserId
}

/**
 * Подтягивает тип чата из флага `is_channel`, если запрос метаданных чата не удался.
 */
function fallbackChatType(isChannel: boolean): ChatType {
  return isChannel ? 'channel' : 'chat'
}

/**
 * Регистрирует чат при появлении бота и шлёт уведомление администратору.
 */
async function registerChannelOnBotJoin(
  ctx: Context,
  chatId: number,
  isChannel: boolean,
  notificationService: ReturnType<typeof createNotificationService>,
): Promise<void> {
  try {
    const chat = await ctx.getChat(chatId)
    channelRegistry.saveChannel(chatId, { title: chat.title, type: chat.type })
    await notificationService.notifyAdmin(
      `✅ Bot added to channel: ${chat.title ?? '—'} (ID: ${chatId})`,
    )
  } catch (e) {
    logger.error('registerChannelOnBotJoin: не удалось получить чат через API', e)
    channelRegistry.saveChannel(chatId, {
      title: null,
      type: fallbackChatType(isChannel),
    })
    await notificationService.notifyAdmin(
      `✅ Bot added to channel: — (ID: ${chatId})`,
    )
  }
}

/**
 * Удаляет чат из реестра и уведомляет администратора (один раз, если запись была).
 */
async function unregisterChannelOnBotLeave(
  chatId: number,
  notificationService: ReturnType<typeof createNotificationService>,
): Promise<void> {
  const removed = channelRegistry.removeChannel(chatId)
  if (!removed) {
    return
  }
  await notificationService.notifyAdmin(
    `❌ Bot removed from channel: ${removed.title ?? '—'} (ID: ${chatId})`,
  )
}

export function registerEventHandlers(bot: Bot): void {
  const notificationService = createNotificationService(bot, config.ADMIN_CHAT_ID)

  bot.on('bot_added', async (ctx) => {
    const { chat_id, is_channel: isChannel } = ctx.update
    logger.info(`bot_added: chat_id=${chat_id}`)
    await registerChannelOnBotJoin(ctx, chat_id, isChannel, notificationService)
  })

  bot.on('bot_removed', async (ctx) => {
    const { chat_id } = ctx.update
    logger.info(`bot_removed: chat_id=${chat_id}`)
    await unregisterChannelOnBotLeave(chat_id, notificationService)
  })

  /**
   * MAX использует `user_added`, когда участник вступает в чат.
   * Если участник — сам бот, обрабатываем как подключение к каналу (на случай, если `bot_added` не пришёл).
   */
  bot.on('user_added', async (ctx) => {
    const { chat_id, is_channel: isChannel } = ctx.update
    const addedUserId = ctx.user?.user_id
    const botNumericId = ctx.myId
    if (
      addedUserId === undefined ||
      botNumericId === undefined ||
      addedUserId !== botNumericId
    ) {
      return
    }
    if (channelRegistry.getChannel(chat_id) !== null) {
      return
    }
    logger.info(`user_added (self): chat_id=${chat_id}`)
    await registerChannelOnBotJoin(ctx, chat_id, isChannel, notificationService)
  })

  /**
   * Аналогично `user_removed`: если удалили бота, дублируем логику `bot_removed`, если событие одно из двух.
   */
  bot.on('user_removed', async (ctx) => {
    const { chat_id } = ctx.update
    const removedUserId = ctx.user?.user_id
    const botNumericId = ctx.myId
    if (
      removedUserId === undefined ||
      botNumericId === undefined ||
      removedUserId !== botNumericId
    ) {
      return
    }
    logger.info(`user_removed (self): chat_id=${chat_id}`)
    await unregisterChannelOnBotLeave(chat_id, notificationService)
  })

  bot.on('bot_started', async (ctx) => {
    const user = ctx.user
    if (!user) {
      return
    }

    const chatId = ctx.chatId
    if (chatId === undefined) {
      logger.warn('bot_started: нет chat_id в контексте')
      return
    }

    logger.info(`bot_started: пользователь ${user.user_id}, chat ${chatId}`)

    const payload = ctx.startPayload
    if (payload) {
      const parsed = parsePayload(payload)

      if (parsed?.type === 'post') {
        stateManager.setState(chatId, user.user_id, {
          mode: 'commenting',
          postId: parsed.id,
          createdAt: new Date(),
        })

        await ctx.reply('📝 Напишите ваш комментарий. Я передам его автору канала.')
        return
      }
    }

    await ctx.reply('👋 Привет! Нажмите на кнопку под постом, чтобы оставить комментарий.')
  })

  bot.on('message_created', async (ctx) => {
    const message = ctx.message
    if (!message) {
      return
    }
    const user = message.sender
    if (!user) {
      return
    }

    const chatId = resolveMessageChatId(message, user.user_id)
    logger.info(`message_created: от ${user.user_id} в чате ${chatId}`)

    const text = message.body.text?.trim() ?? ''

    if (text === '/status') {
      const reg = channelRegistry.getChannel(chatId)
      const states = stateManager.countStatesInChat(chatId)
      const comments = commentService.countByChatId(chatId)
      const title = reg?.title ?? '—'
      const type = reg?.type ?? '—'
      const inRegistry = reg !== null ? 'да' : 'нет'
      const added = reg?.date_added ?? '—'
      await ctx.reply(
        `📊 Текущий чат\nID: ${chatId}\nНазвание: ${title}\nТип: ${type}\nВ реестре: ${inRegistry}\nДата добавления в реестр: ${added}\nАктивных сессий (состояний): ${states}\nКомментариев из этого чата: ${comments}`,
      )
      return
    }

    if (text === '/channels') {
      if (chatId !== config.ADMIN_CHAT_ID) {
        await ctx.reply('Команда /channels доступна только из админского чата.')
        return
      }
      const all = channelRegistry.getAllChannels()
      if (all.length === 0) {
        await ctx.reply('Подключённых каналов пока нет.')
        return
      }
      const lines = all.map(
        (c) => `• ${c.title ?? '—'} — ID ${c.chat_id} (${c.type}), с ${c.date_added}`,
      )
      await ctx.reply(`Подключённые каналы (${all.length}):\n${lines.join('\n')}`)
      return
    }

    const state = stateManager.getState(chatId, user.user_id)

    if (!state) {
      await ctx.reply('👋 Привет! Нажмите на кнопку под постом для комментария.')
      return
    }

    if (state.mode === 'commenting' && state.postId) {
      const trimmed = text.trim()
      if (!trimmed) {
        await ctx.reply('Пожалуйста, отправьте текст комментария (не пустое сообщение).')
        return
      }

      await commentService.create({
        sourceChatId: chatId,
        postId: state.postId,
        userId: user.user_id,
        userName: user.name || 'Пользователь',
        text: trimmed,
      })

      await notificationService.notifyNewComment({
        postId: state.postId,
        userId: user.user_id,
        userName: user.name || 'Пользователь',
        text: trimmed,
        sourceChatId: chatId,
      })

      await ctx.reply('✅ Спасибо! Ваш комментарий отправлен на модерацию.')
      stateManager.deleteState(chatId, user.user_id)
      return
    }

    if (state.mode === 'replying' && state.replyToUserId) {
      const userId = state.replyToUserId

      await notificationService.notifyUserAboutReply(userId, text)
      await ctx.reply('✅ Ответ отправлен пользователю.')

      stateManager.deleteState(chatId, user.user_id)
      return
    }
  })

  bot.on('message_callback', async (ctx) => {
    const user = ctx.user
    if (!user) {
      return
    }

    const chatId = resolveCallbackChatId(ctx, user.user_id)
    const callbackData = ctx.callback?.payload
    logger.info(`message_callback: payload=${callbackData}, chat=${chatId}`)

    if (callbackData?.startsWith('reply_')) {
      const userIdStr = callbackData.replace('reply_', '')
      const userId = parseInt(userIdStr, 10)
      if (!Number.isFinite(userId) || !Number.isInteger(userId) || userId <= 0) {
        await ctx.answerOnCallback({
          notification: 'Не удалось распознать получателя ответа.',
        })
        return
      }

      stateManager.setState(chatId, user.user_id, {
        mode: 'replying',
        replyToUserId: userId,
        createdAt: new Date(),
      })

      await ctx.answerOnCallback({
        notification: 'Напишите ответ в этом чате.',
      })
      await ctx.reply('📝 Напишите ответ на комментарий.')
      return
    }

    await ctx.answerOnCallback({ notification: 'Готово.' })
  })

  logger.info('✅ Обработчики событий зарегистрированы')
}
