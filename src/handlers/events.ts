import { Bot, Context, Keyboard } from '@maxhub/max-bot-api'
import type { ChatType } from '@maxhub/max-bot-api/types'
import type { Chat, ChatMember, Message, User } from '@maxhub/max-bot-api/types'

import { config } from '../config'
import {
  isLikelyChannelPost,
  isUserChannelAdmin,
  resolveMessageChatId,
  tryAttachCommentsToChannelPost,
} from '../services/channelPostActions'
import { channelNotifyLinkStore } from '../services/channelNotifyLinkStore'
import { channelRegistry } from '../services/channelRegistry'
import { resolveChannelChatIdFromInviteParam } from '../services/resolveChannelChatId'
import { commentStore } from '../services/commentStore'
import { notifyAllAdmins, type SendMessageExtra } from '../services/notificationService'
import { postStore } from '../services/postStore'
import { settingsStore } from '../services/settingsStore'
import { subscriberStore } from '../services/subscriberStore'
import { stateManager } from '../services/stateManager'
import { logger } from '../utils/logger'

function buildBotStartappUrl(startappPayload: string): string {
  const nick = config.botNickname.trim()
  return `https://max.ru/${nick}?startapp=${startappPayload}`
}

function buildMiniAppHomeUrl(): string {
  return buildBotStartappUrl('start')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** MAX `bot_started` payload (tolerate alternate field names). */
function getBotStartPayload(ctx: Context): string {
  const u = ctx.update as { payload?: string | null; start_payload?: string | null }
  return (u.payload ?? u.start_payload ?? '').trim()
}

async function fetchChannelParticipantsCount(bot: Bot, channelChatId: number): Promise<number> {
  try {
    const chat = await bot.api.getChat(channelChatId)
    return chat.participants_count ?? 0
  } catch {
    return 0
  }
}

/** First registered channel (sorted by id) where the user is admin or owner. */
async function findFirstRegisteredChannelWhereUserIsAdmin(
  bot: Bot,
  userId: number,
): Promise<{ chatId: number; title: string | null } | null> {
  const channels = channelRegistry.getAllChannels().filter((c) => c.type === 'channel')
  channels.sort((a, b) => a.chat_id - b.chat_id)
  for (const c of channels) {
    if (await isUserChannelAdmin(bot, c.chat_id, userId)) {
      return { chatId: c.chat_id, title: c.title }
    }
  }
  return null
}

/**
 * For `subscribe` deep link: prefer a registered channel where the user is a non-admin member.
 */
async function resolveSubscribeWelcomeChannel(
  bot: Bot,
  userId: number,
): Promise<{ chatId: number; title: string | null }> {
  const channels = channelRegistry.getAllChannels().filter((c) => c.type === 'channel')
  channels.sort((a, b) => a.chat_id - b.chat_id)
  for (const c of channels) {
    try {
      const { members } = await bot.api.getChatMembers(c.chat_id, { user_ids: [userId] })
      const m = members[0]
      if (m && !m.is_bot && !m.is_admin && !m.is_owner) {
        return { chatId: c.chat_id, title: c.title }
      }
    } catch {
      /* try next */
    }
  }
  const first = channels[0]
  if (first) {
    return { chatId: first.chat_id, title: first.title }
  }
  return { chatId: 0, title: 'канала' }
}

/**
 * Подтягивает тип чата из флага `is_channel`, если запрос метаданных чата не удался.
 */
function fallbackChatType(isChannel: boolean): ChatType {
  return isChannel ? 'channel' : 'chat'
}

/**
 * Sends a DM by user id; logs and ignores failures (user blocked the bot or never pressed Start).
 */
async function trySendDmToUser(
  bot: Bot,
  userId: number,
  text: string,
  extra?: SendMessageExtra,
): Promise<void> {
  try {
    await bot.api.sendMessageToUser(userId, text, extra)
  } catch (err: unknown) {
    logger.warn('trySendDmToUser: could not deliver private message', { userId, err })
  }
}

/**
 * Loads the bot's own {@link ChatMember} row in a chat via `GET chats/{id}/members/me`.
 */
async function fetchBotChatMember(bot: Bot, channelChatId: number): Promise<ChatMember | null> {
  try {
    return await bot.api.getChatMembership(channelChatId)
  } catch (err: unknown) {
    logger.warn('fetchBotChatMember: API error', { channelChatId, err })
    return null
  }
}

/** Whether the bot is allowed to moderate the channel (admin or owner). */
function isBotAdminOrOwner(member: ChatMember): boolean {
  return member.is_admin || member.is_owner
}

async function fetchChatTitle(bot: Bot, channelChatId: number): Promise<string | null> {
  try {
    const chat = await bot.api.getChat(channelChatId)
    return chat.title ?? null
  } catch {
    return null
  }
}

async function fetchChatType(bot: Bot, channelChatId: number): Promise<ChatType | null> {
  try {
    const chat = await bot.api.getChat(channelChatId)
    return chat.type
  } catch {
    return null
  }
}

/**
 * Resolves who should receive onboarding DMs: for `bot_added` this is `ctx.user` (who added the bot);
 * for `user_added` (self) use `inviter_id` only — `ctx.user` is the bot, not a human recipient.
 */
function resolveInviterUserId(
  updateType: Context['update']['update_type'],
  addedByUserFromContext: User | undefined,
  inviterId: number | null | undefined,
): number | undefined {
  if (updateType === 'bot_added') {
    const id = addedByUserFromContext?.user_id
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
      return id
    }
    return undefined
  }
  if (updateType === 'user_added') {
    if (typeof inviterId === 'number' && Number.isInteger(inviterId) && inviterId > 0) {
      return inviterId
    }
    return undefined
  }
  return undefined
}

/**
 * Parses `/connect` with optional positive integer channel id.
 * Returns `false` when the message is not this command, or `undefined` when the argument is invalid.
 */
function parseConnectCommand(
  text: string,
): false | { mode: 'all' } | { mode: 'one'; channelId: number } | undefined {
  const t = text.trim()
  if (!/^\/connect\b/i.test(t)) {
    return false
  }
  const rest = t.replace(/^\/connect\b/i, '').trim()
  if (rest === '') {
    return { mode: 'all' }
  }
  const channelId = Number.parseInt(rest, 10)
  if (!Number.isInteger(channelId) || channelId <= 0) {
    return undefined
  }
  return { mode: 'one', channelId }
}

type ParsedAddButton =
  | { kind: 'channel_and_mid'; channelChatId: number; mid: string }
  | { kind: 'mid_only'; mid: string }

/**
 * Parses `/addbutton` arguments: `mid`, or `channel_chat_id mid`.
 */
function parseAddButtonInput(raw: string): ParsedAddButton | undefined {
  const t = raw.trim()
  if (t === '') {
    return undefined
  }
  const two = /^(-?\d+)\s+(\S+)$/.exec(t)
  if (two) {
    const channelChatId = Number(two[1])
    if (!Number.isFinite(channelChatId)) {
      return undefined
    }
    return { kind: 'channel_and_mid', channelChatId, mid: two[2] }
  }
  if (/\s/.test(t)) {
    return undefined
  }
  return { kind: 'mid_only', mid: t }
}

type ChannelActivationOutcome =
  | { status: 'registered' }
  | { status: 'already_registered' }
  | { status: 'pending'; shouldNotifyMissingAdmin: boolean }

/**
 * In-memory: we already sent the "bot joined with admin rights" admin notification for this chat.
 * Cleared on {@link unregisterChannelOnBotLeave}. Survives pending→admin transitions without duplicate notify.
 */
const channelsAdminJoinNotified = new Set<number>()

/**
 * Persists channel metadata to the registry as soon as the bot is in the chat.
 * Admin rights only gate processing/notifications elsewhere, not whether the row exists on disk.
 */
async function ensureChannelPersisted(ctx: Context, chatId: number, isChannel: boolean): Promise<void> {
  try {
    const chat = await ctx.getChat(chatId)
    const chatData = { title: chat.title, type: chat.type }
    logger.info('DEBUG: calling saveChannel', { chatId, chatData })
    channelRegistry.saveChannel(chatId, chatData)
    logger.info('DEBUG: saveChannel done, file should exist now')
  } catch (e) {
    logger.error('ensureChannelPersisted: не удалось получить чат через API', e)
    const chatData = { title: null, type: fallbackChatType(isChannel) }
    logger.info('DEBUG: calling saveChannel', { chatId, chatData })
    channelRegistry.saveChannel(chatId, chatData)
    logger.info('DEBUG: saveChannel done, file should exist now')
  }
}

async function notifyAdminsChannelJoined(bot: Bot, channelChatId: number): Promise<void> {
  const reg = channelRegistry.getChannel(channelChatId)
  const title = reg?.title ?? '—'
  await notifyAllAdmins(bot, channelChatId, `✅ Bot added to channel: ${title} (ID: ${channelChatId})`)
}

/**
 * Публичное сообщение в канал с deep link для админов, подписывающихся на уведомления о комментариях.
 */
async function postChannelAdminInviteToChannel(bot: Bot, channelChatId: number): Promise<void> {
  const nick = config.botNickname.trim()
  if (!nick) {
    logger.warn('postChannelAdminInviteToChannel: botNickname пустой')
    return
  }
  const joinPayload = `join${Math.abs(channelChatId)}`
  const joinUrl = `https://max.ru/${nick}?startapp=${joinPayload}`
  const text =
    '👋 CommentBot подключён к каналу!\n\n' +
    'Администраторы — чтобы получать уведомления о комментариях, нажмите кнопку ниже и запустите бота.'
  try {
    await bot.api.sendMessageToChat(channelChatId, text, {
      attachments: [
        Keyboard.inlineKeyboard([
          [Keyboard.button.link('🔔 Получать уведомления о комментариях', joinUrl)],
        ]),
      ],
    })
  } catch (err: unknown) {
    logger.warn('postChannelAdminInviteToChannel: не удалось отправить сообщение в канал', {
      channelChatId,
      err,
    })
  }
}

/**
 * Verifies admin/owner rights, persists channel metadata up front, sends admin join notify once when admin is OK.
 */
async function tryActivateChannelRegistration(
  ctx: Context,
  bot: Bot,
  channelChatId: number,
  isChannel: boolean,
): Promise<ChannelActivationOutcome> {
  await ensureChannelPersisted(ctx, channelChatId, isChannel)

  const member = await fetchBotChatMember(bot, channelChatId)
  if (!member) {
    stateManager.markChannelPendingAdminRights(channelChatId)
    return { status: 'pending', shouldNotifyMissingAdmin: false }
  }
  if (!isBotAdminOrOwner(member)) {
    stateManager.markChannelPendingAdminRights(channelChatId)
    return { status: 'pending', shouldNotifyMissingAdmin: true }
  }

  stateManager.clearChannelPendingAdminRights(channelChatId)
  if (channelsAdminJoinNotified.has(channelChatId)) {
    return { status: 'already_registered' }
  }

  await notifyAdminsChannelJoined(bot, channelChatId)
  await postChannelAdminInviteToChannel(bot, channelChatId)
  channelsAdminJoinNotified.add(channelChatId)
  return { status: 'registered' }
}

async function dmInviterAboutMissingAdmin(
  bot: Bot,
  inviterUserId: number | undefined,
  channelChatId: number,
  channelTitle: string | null,
): Promise<void> {
  const title = channelTitle ?? '—'
  const text = `⚠️ I was added to "${title}" but I need admin rights to work.

Please grant me admin rights, then I'll connect automatically.

If nothing happens, open this chat and send: /connect ${channelChatId}`

  if (inviterUserId !== undefined) {
    await trySendDmToUser(bot, inviterUserId, text)
    return
  }

  logger.warn('dmInviterAboutMissingAdmin: no inviter user id; skipping DM', { channelChatId })
}

/**
 * Удаляет чат из реестра и уведомляет администратора (один раз, если запись была).
 */
async function unregisterChannelOnBotLeave(bot: Bot, chatId: number): Promise<void> {
  stateManager.clearChannelPendingAdminRights(chatId)
  channelsAdminJoinNotified.delete(chatId)
  channelNotifyLinkStore.removeAllForChannel(chatId)
  const removed = channelRegistry.removeChannel(chatId)
  if (!removed) {
    return
  }
  await notifyAllAdmins(
    bot,
    chatId,
    `❌ Bot removed from channel: ${removed.title ?? '—'} (ID: ${chatId})`,
  )
}

export function registerEventHandlers(bot: Bot): void {
  bot.on('bot_added', async (ctx) => {
    const { chat_id: channelChatId, is_channel: isChannel } = ctx.update
    logger.info(`bot_added: chat_id=${channelChatId}`)

    const outcome = await tryActivateChannelRegistration(ctx, bot, channelChatId, isChannel)
    if (outcome.status === 'pending' && outcome.shouldNotifyMissingAdmin) {
      const inviter = resolveInviterUserId(ctx.update.update_type, ctx.user, undefined)
      const title = await fetchChatTitle(bot, channelChatId)
      await dmInviterAboutMissingAdmin(bot, inviter, channelChatId, title)
    }
  })

  bot.on('bot_removed', async (ctx) => {
    const { chat_id } = ctx.update
    logger.info(`bot_removed: chat_id=${chat_id}`)
    await unregisterChannelOnBotLeave(bot, chat_id)
  })

  /**
   * MAX использует `user_added`, когда участник вступает в чат.
   * Если участник — сам бот, обрабатываем как подключение к каналу (на случай, если `bot_added` не пришёл).
   */
  bot.on('user_added', async (ctx) => {
    const { chat_id: channelChatId, is_channel: isChannel, inviter_id: inviterId } = ctx.update
    const addedUserId = ctx.user?.user_id
    const botNumericId = ctx.myId
    if (
      addedUserId === undefined ||
      botNumericId === undefined ||
      addedUserId !== botNumericId
    ) {
      return
    }
    if (channelRegistry.getChannel(channelChatId) !== null) {
      return
    }
    logger.info(`user_added (self): chat_id=${channelChatId}`)

    const outcome = await tryActivateChannelRegistration(ctx, bot, channelChatId, isChannel)
    if (outcome.status === 'pending' && outcome.shouldNotifyMissingAdmin) {
      const inviter = resolveInviterUserId(ctx.update.update_type, ctx.user, inviterId)
      const title = await fetchChatTitle(bot, channelChatId)
      await dmInviterAboutMissingAdmin(bot, inviter, channelChatId, title)
    }
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
    await unregisterChannelOnBotLeave(bot, chat_id)
  })

  bot.on('bot_started', async (ctx) => {
    try {
      const startPayload = getBotStartPayload(ctx)
      const userId = ctx.user?.user_id

      logger.info('bot_started fired', {
        userId,
        payload: startPayload,
        updateRaw: JSON.stringify(ctx.update).slice(0, 200),
      })

      if (!userId) {
        return
      }

      const chatId = ctx.chatId
      if (chatId !== undefined) {
        stateManager.setUserPrivateChatId(userId, chatId)
      }

      const firstBotStart = !subscriberStore.hasSubscriber(userId)
      subscriberStore.addSubscriber(userId)
      logger.info('bot_started: registered subscriber', { userId, payload: startPayload })

      // Mini App opened from channel post — silent registration only
      if (startPayload.startsWith('pid_')) {
        const m = startPayload.match(/^pid_[a-f0-9]+_cid_(\d+)/)
        if (m) {
          const channelChatId = -Number.parseInt(m[1]!, 10)
          logger.info('bot_started: linked to channel via post', { userId, chatId: channelChatId })
        }
        return
      }

      // Comments gate: user tapped «Запустить бота» in Mini App
      if (/^sub_\d+$/i.test(startPayload)) {
        const welcomeText =
          '✅ Отлично! Бот запущен.\n\n' +
          'Теперь когда администраторы канала ответят ' +
          'на ваш комментарий — я сразу пришлю вам сообщение.\n\n' +
          'Можете вернуться в канал и написать комментарий!'
        await bot.api.sendMessageToUser(userId, welcomeText)
        return
      }

      if (chatId === undefined) {
        logger.warn('bot_started: нет chat_id в контексте')
        return
      }

      const firstName = ctx.user?.name || 'пользователь'

      const homeUrl = buildMiniAppHomeUrl()

      const sendUser = async (text: string, kb: ReturnType<typeof Keyboard.inlineKeyboard>): Promise<void> => {
        await bot.api.sendMessageToUser(userId, text, { attachments: [kb] })
      }

      // 1) Admin invited via join link
      if (startPayload.toLowerCase().startsWith('join') && /^join\d+$/i.test(startPayload)) {
        const channelChatId = resolveChannelChatIdFromInviteParam(startPayload)
        if (channelChatId === null) {
          const kb = Keyboard.inlineKeyboard([[Keyboard.button.link('🚀 Подключить канал', homeUrl)]])
          await sendUser(
            `Не удалось разобрать ссылку приглашения. Откройте мини-приложение и попробуйте снова.`,
            kb,
          )
          return
        }

        const isAdmin = await isUserChannelAdmin(bot, channelChatId, userId)
        if (!isAdmin) {
          const kb = Keyboard.inlineKeyboard([[Keyboard.button.link('💬 Открыть панель управления', homeUrl)]])
          await sendUser(
            `Эта ссылка для администраторов канала. Если вы администратор, убедитесь, что вы вошли в MAX под нужным аккаунтом.`,
            kb,
          )
          return
        }

        settingsStore.linkUserToChannel(userId, channelChatId)
        await settingsStore.forcePersist()

        let channelTitle = channelRegistry.getChannel(channelChatId)?.title ?? null
        if (!channelTitle) {
          channelTitle = await fetchChatTitle(bot, channelChatId)
        }
        const displayTitle = channelTitle ?? 'канал'
        const subscribers = await fetchChannelParticipantsCount(bot, channelChatId)

        const adminText = `🎉 Добро пожаловать, ${firstName}!

Вы подключены как администратор канала «${displayTitle}».

Теперь вы будете получать уведомления о новых комментариях и сможете отвечать от имени канала прямо в мини-приложении.`

        const adminKb = Keyboard.inlineKeyboard([
          [Keyboard.button.link('💬 Открыть панель управления', homeUrl)],
          [Keyboard.button.callback('⚙️ Настройки уведомлений', 'settings')],
        ])
        await sendUser(adminText, adminKb)
        await delay(1000)
        await bot.api.sendMessageToUser(
          userId,
          `Канал: ${displayTitle} · ${subscribers} подписчиков`,
        )
        return
      }

      // 2) Subscriber deep link
      if (startPayload === 'subscribe') {
        const { title } = await resolveSubscribeWelcomeChannel(bot, userId)
        const channelTitle = title ?? 'канала'
        const subText = `🔔 Вы подписаны на уведомления!

Когда администраторы канала «${channelTitle}» ответят на ваш комментарий — я сразу пришлю вам сообщение.

Чтобы написать комментарий — откройте любой пост канала и нажмите кнопку «💬 Комментарии».`

        const subKb = Keyboard.inlineKeyboard([
          [Keyboard.button.callback('🔕 Отключить уведомления', 'unsubscribe')],
        ])
        await sendUser(subText, subKb)
        return
      }

      // 3) Channel owner — first /start, no payload, admin of a registered channel
      if (startPayload === '' && firstBotStart) {
        const adminChannel = await findFirstRegisteredChannelWhereUserIsAdmin(bot, userId)
        if (adminChannel) {
          const displayTitle = adminChannel.title ?? 'канал'
          const ownerText = `✅ Канал успешно подключён!

Канал «${displayTitle}» теперь использует CommentBot.

Следующий шаг — пригласите других администраторов, чтобы они тоже получали уведомления о комментариях.`

          const ownerKb = Keyboard.inlineKeyboard([
            [Keyboard.button.callback('👥 Пригласить администраторов', 'invite_admins')],
            [Keyboard.button.link('💬 Открыть панель управления', homeUrl)],
          ])
          await sendUser(ownerText, ownerKb)
          return
        }
      }

      // 4) Default new user
      const newUserText = `👋 Привет, ${firstName}!

Я CommentBot — система комментариев для каналов MAX.

С моей помощью подписчики смогут оставлять комментарии к постам прямо внутри мессенджера, а вы — отвечать от имени канала.

Что умею:
💬 Комментарии под каждым постом
🔔 Мгновенные уведомления
📢 Ответы от имени канала
📊 Статистика по комментариям`

      const newUserKb = Keyboard.inlineKeyboard([
        [Keyboard.button.link('🚀 Подключить канал', homeUrl)],
        [Keyboard.button.callback('📖 Как это работает', 'how_it_works')],
      ])
      await sendUser(newUserText, newUserKb)
    } catch (err: unknown) {
      logger.error('bot_started: handler error', err)
    }
  })

  bot.on('message_callback', async (ctx) => {
    try {
      const cb = ctx.callback
      if (!cb?.user) {
        return
      }
      const userId = cb.user.user_id
      const rawPayload = (cb.payload ?? '').trim()

      try {
        await ctx.answerOnCallback({})
      } catch (e: unknown) {
        logger.warn('message_callback: answerOnCallback failed', { userId, e })
      }

      const homeUrl = buildMiniAppHomeUrl()
      const nick = config.botNickname.trim()

      if (rawPayload === 'how_it_works') {
        const howText = `📖 Как работает CommentBot:

1️⃣ Добавьте бота в канал как администратора
2️⃣ Под каждым постом появится кнопка «💬 Комментарии»
3️⃣ Подписчики нажимают кнопку и пишут комментарии прямо в MAX
4️⃣ Вы получаете уведомление с текстом комментария
5️⃣ Отвечаете от имени канала — подписчик получает ваш ответ

Всё общение происходит внутри MAX без внешних сайтов.`
        const howKb = Keyboard.inlineKeyboard([[Keyboard.button.link('🚀 Подключить канал', homeUrl)]])
        await bot.api.sendMessageToUser(userId, howText, { attachments: [howKb] })
        return
      }

      if (rawPayload === 'settings') {
        await bot.api.sendMessageToUser(
          userId,
          `⚙️ Настройки уведомлений\n\nОткройте мини-приложение и нажмите «Настройки канала» вверху экрана.`,
          {
            attachments: [
              Keyboard.inlineKeyboard([[Keyboard.button.link('Открыть мини-приложение', homeUrl)]]),
            ],
          },
        )
        return
      }

      if (rawPayload === 'unsubscribe') {
        subscriberStore.removeSubscriber(userId)
        await bot.api.sendMessageToUser(
          userId,
          'Вы отключили уведомления. Чтобы снова получать ответы канала в личку — нажмите «Подписаться» в мини-приложении или напишите боту /start.',
        )
        return
      }

      if (rawPayload === 'invite_admins') {
        const ch = await findFirstRegisteredChannelWhereUserIsAdmin(bot, userId)
        if (!ch) {
          await bot.api.sendMessageToUser(
            userId,
            'Не найден подключённый канал, где вы администратор. Добавьте бота в канал и выдайте права администратора.',
          )
          return
        }
        const channelTitle = ch.title ?? 'канал'
        const inviteUrl = `https://max.ru/${nick}?startapp=join${Math.abs(ch.chatId)}`
        await bot.api.sendMessageToUser(
          userId,
          `Отправьте эту ссылку другим администраторам канала «${channelTitle}»:

${inviteUrl}

Администратор нажмёт на ссылку → запустит бота → начнёт получать уведомления.`,
        )
      }
    } catch (err: unknown) {
      logger.error('message_callback: handler error', err)
    }
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

    if (message.recipient.chat_type === 'dialog') {
      if (/^\/stop\b/i.test(text) || /^\/unsubscribe\b/i.test(text)) {
        subscriberStore.removeSubscriber(user.user_id)
        await ctx.reply('Уведомления отключены. Чтобы включить снова — напишите /start')
        return
      }
      if (/^\/start\b/i.test(text)) {
        subscriberStore.addSubscriber(user.user_id)
        await ctx.reply(
          'Уведомления включены. Когда канал ответит на ваш комментарий, вы получите сообщение здесь.',
        )
        return
      }
    }

    if (/^\/addbutton\b/i.test(text)) {
      const rawArgs = text.replace(/^\/addbutton\b/i, '').trim()
      const parsedAb = parseAddButtonInput(rawArgs)
      if (parsedAb === undefined) {
        await ctx.reply(
          'Usage:\n' +
            '/addbutton <message_mid>\n' +
            'or\n' +
            '/addbutton <channel_chat_id> <message_mid>\n\n' +
            'Use /channels (admin chat) to see channel_chat_id if needed.',
        )
        return
      }
      let currentChat: Chat
      try {
        currentChat = await ctx.api.getChat(chatId)
      } catch (err: unknown) {
        logger.warn('message_created /addbutton: getChat failed', { chatId, err })
        await ctx.reply('Could not load this chat. Try again later.')
        return
      }
      if (currentChat.type !== 'dialog') {
        await ctx.reply('/addbutton works only in a private chat with the bot.')
        return
      }

      let loaded: Message
      let channelChatId: number
      try {
        if (parsedAb.kind === 'channel_and_mid') {
          channelChatId = parsedAb.channelChatId
          loaded = await bot.api.getMessage(parsedAb.mid)
          const rid = loaded.recipient.chat_id
          if (typeof rid === 'number' && Number.isFinite(rid) && rid !== channelChatId) {
            await ctx.reply(
              `That message belongs to chat ${rid}, not ${channelChatId}. Check the channel id.`,
            )
            return
          }
        } else {
          loaded = await bot.api.getMessage(parsedAb.mid)
          const rid = loaded.recipient.chat_id
          if (typeof rid === 'number' && Number.isFinite(rid)) {
            channelChatId = rid
          } else {
            const onlyChannels = channelRegistry.getAllChannels().filter((c) => c.type === 'channel')
            if (onlyChannels.length === 1) {
              channelChatId = onlyChannels[0]!.chat_id
            } else {
              await ctx.reply(
                'Could not detect channel from the message. Use:\n' +
                  '/addbutton <channel_chat_id> <message_mid>',
              )
              return
            }
          }
        }
      } catch (err: unknown) {
        logger.warn('message_created /addbutton: getMessage failed', { err })
        await ctx.reply('Could not load the message by mid. Check the id and bot access to the channel.')
        return
      }

      if (!(await isUserChannelAdmin(bot, channelChatId, user.user_id))) {
        await ctx.reply('You must be a channel admin to add the button.')
        return
      }

      const r = await tryAttachCommentsToChannelPost(bot, loaded, {
        botUserId: ctx.myId,
        channelChatIdOverride: channelChatId,
        skipAuthorAdminCheck: true,
      })
      if (r.ok) {
        await ctx.reply('Button added to post.')
        return
      }
      if (r.reason === 'already_exists') {
        await ctx.reply('This post already has the comments button.')
        return
      }
      if (r.reason === 'no_miniapp') {
        await ctx.reply('Mini App links are not configured (set BOT_NICKNAME or MINI_APP_URL).')
        return
      }
      if (r.reason === 'skip_bot') {
        await ctx.reply('Cannot attach to a message sent by the bot.')
        return
      }
      await ctx.reply(`Could not add the button (${r.reason}).`)
      return
    }

    const channelLikely = await isLikelyChannelPost(bot, message)
    if (channelLikely) {
      logger.info('message_created: channel-shaped message', {
        chatId,
        recipientChatType: message.recipient.chat_type,
        messageMid: message.body.mid,
      })
      const r = await tryAttachCommentsToChannelPost(bot, message, { botUserId: ctx.myId })
      if (r.ok) {
        logger.info('message_created: comment button attached (push path)', {
          messageMid: message.body.mid,
        })
      }
      return
    }

    const parsedConnect = parseConnectCommand(text)
    if (parsedConnect === undefined) {
      await ctx.reply('Usage: /connect  or  /connect <channel_id>')
      return
    }
    if (parsedConnect !== false) {
      let currentChat: Chat
      try {
        currentChat = await ctx.api.getChat(chatId)
      } catch (err: unknown) {
        logger.warn('message_created /connect: getChat failed', { chatId, err })
        await ctx.reply('Could not load this chat. Try again later.')
        return
      }
      if (currentChat.type !== 'dialog') {
        await ctx.reply('/connect works only in a private chat with the bot.')
        return
      }
      const targets: number[] =
        parsedConnect.mode === 'one'
          ? [parsedConnect.channelId]
          : stateManager.getPendingAdminChannelIds()

      if (targets.length === 0) {
        await ctx.reply('No channels are waiting for admin rights. Add the bot to a channel first.')
        return
      }

      const lines: string[] = []
      for (const channelChatId of targets) {
        const chatType = await fetchChatType(bot, channelChatId)
        const isChannelFlag = chatType === null ? true : chatType === 'channel'
        const outcome = await tryActivateChannelRegistration(
          ctx,
          bot,
          channelChatId,
          isChannelFlag,
        )
        if (outcome.status === 'registered') {
          lines.push(`✅ Channel ${channelChatId}: connected.`)
        } else if (outcome.status === 'already_registered') {
          lines.push(`ℹ️ Channel ${channelChatId}: already connected.`)
        } else if (outcome.status === 'pending') {
          lines.push(
            `⏳ Channel ${channelChatId}: still not admin, or API could not verify membership. Grant admin rights and run /connect again.`,
          )
        }
      }
      await ctx.reply(lines.join('\n'))
      return
    }

    if (text === '/status') {
      const reg = channelRegistry.getChannel(chatId)
      const states = stateManager.countStatesInChat(chatId)
      const postIds = new Set(postStore.getPostsByChatId(chatId).map((p) => p.post_id))
      const comments = commentStore.countForPostIds(postIds)
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
      await ctx.reply('👋 Откройте мини-приложение по кнопке «Комментарии» под постом в канале.')
      return
    }

    await ctx.reply('Сессия устарела. Откройте комментарии снова из канала.')
    stateManager.deleteState(chatId, user.user_id)
  })

  logger.info('✅ Обработчики событий зарегистрированы')
}
