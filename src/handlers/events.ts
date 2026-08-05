import { Bot, Context, Keyboard } from '@maxhub/max-bot-api'
import type { ChatType } from '@maxhub/max-bot-api/types'
import type { Chat, Message, User } from '@maxhub/max-bot-api/types'

import { config } from '../config'
import { parseConfirmChannelLinkPayload } from '../utils/channelLinkCallback'
import { MAX_BOOKED_IN_TG_CALLBACK } from '../utils/commentSyncFilter'
import {
  fetchBotChatMember,
  fetchBotChatMemberWithRetry,
  isBotAdminOrOwner,
} from '../services/botChannelMembership'
import {
  clearAdminJoinNotifiedForChannel,
  hasChannelAdminJoinNotified,
  markChannelAdminJoinNotified,
} from '../services/channelAdminJoinNotified'
import { scheduleCommentButtonRetry } from '../services/commentButtonRetryQueue'
import { runChannelPollerForChat } from '../services/channelPoller'
import {
  isLikelyChannelPost,
  isUserChannelAdmin,
  resolveMessageChatId,
  lookupRegisteredChannelForMessage,
  tryAttachCommentsToChannelPost,
} from '../services/channelPostActions'
import { finalizeChannelLinkDraftInMax } from '../services/channelLinkService'
import { channelRegistry } from '../services/channelRegistry'
import { fullyDisconnectRegisteredChannel } from '../services/channelFullDisconnect'
import { resolveChannelChatIdFromInviteParam } from '../services/resolveChannelChatId'
import { commentStore } from '../services/commentStore'
import { completeAccountPairingFromMax, isAccountPairStartPayload } from '../services/accountPairingService'
import { notifyAllAdmins, type SendMessageExtra } from '../services/notificationService'
import { postStore } from '../services/postStore'
import { settingsStore } from '../services/settingsStore'
import { subscriberStore } from '../services/subscriberStore'
import { stateManager } from '../services/stateManager'
import { buildTelegramNotifyInviteUrlForMaxChannel } from '../services/maxChannelTelegramAdminInvite'
import { onMaxPostPublished } from '../services/vkChainForwarder'
import { buildBotJoinUrl } from '../utils/deeplink'
import { logger } from '../utils/logger'

/**
 * Дублирует пост канала MAX в VK-связки.
 * Служебные сообщения бота (reply-stub кнопки) пропускаем — у них reason skip_bot.
 * Для постов бота (TG→MAX / автопост) даём короткую задержку, чтобы tgChainForwarder
 * успел опубликовать в VK с медиа из Telegram; идемпотентность не даст дубль.
 */
function scheduleVkForwardForMaxChannelPost(
  chatId: number,
  message: Message,
  attachReason: string | undefined,
  botUserId: number | undefined,
): void {
  const mid = message.body?.mid
  if (typeof mid !== 'string' || mid.trim() === '') return
  if (attachReason === 'skip_bot') return

  const postText = message.body?.text?.trim() ?? ''
  const fromBot =
    botUserId !== undefined && message.sender != null && message.sender.user_id === botUserId
  const delayMs = fromBot ? 2_500 : 0

  const run = (): void => {
    void onMaxPostPublished(chatId, mid.trim(), postText).catch((err: unknown) => {
      logger.warn('message_created: VK forward failed', { chatId, messageMid: mid, err })
    })
  }
  if (delayMs > 0) {
    setTimeout(run, delayMs)
  } else {
    run()
  }
}

/** Mini App deeplink (`startapp` → `initDataUnsafe.start_param`). */
function buildBotStartappUrl(startappPayload: string): string {
  const nick = config.botNickname.trim()
  return `https://max.ru/${nick}?startapp=${startappPayload}`
}

const BOT_ACTIVATION_WELCOME_TEXT =
  '✅ Бот активирован!\n\n' +
  'Теперь когда вам ответят на комментарий — я сразу пришлю вам сообщение.\n\n' +
  'Вернитесь в канал и напишите комментарий!'

async function trySendBotActivationWelcome(bot: Bot, chatId: number): Promise<void> {
  try {
    await bot.api.sendMessageToChat(chatId, BOT_ACTIVATION_WELCOME_TEXT)
  } catch (err: unknown) {
    logger.warn('trySendBotActivationWelcome: send failed', { chatId, err })
  }
}

async function handlePrivateChatMessage(bot: Bot, message: Message, user: User): Promise<void> {
  const userId = user.user_id
  const chatId = resolveMessageChatId(message, userId)
  const messageText = message.body?.text?.trim() ?? ''

  logger.info('handlePrivateChatMessage', { userId, chatId, messageText })

  if (/^\/stop\b/i.test(messageText) || /^\/unsubscribe\b/i.test(messageText)) {
    subscriberStore.removeSubscriber(userId)
    try {
      await bot.api.sendMessageToChat(
        chatId,
        'Уведомления отключены. Чтобы включить снова — напишите /start',
      )
    } catch (err: unknown) {
      logger.warn('handlePrivateChatMessage: /stop reply failed', { userId, err })
    }
    return
  }

  if (/^\/start\b/i.test(messageText)) {
    const alreadyRegistered = subscriberStore.hasSubscriber(userId)
    subscriberStore.addSubscriber(userId)
    try {
      if (!alreadyRegistered) {
        await trySendBotActivationWelcome(bot, chatId)
      } else {
        await bot.api.sendMessageToChat(
          chatId,
          'Уведомления включены. Когда канал ответит на ваш комментарий, вы получите сообщение здесь.',
        )
      }
    } catch (err: unknown) {
      logger.warn('handlePrivateChatMessage: /start reply failed', { userId, err })
    }
    return
  }

  const alreadyRegistered = subscriberStore.hasSubscriber(userId)
  if (alreadyRegistered) {
    return
  }

  subscriberStore.addSubscriber(userId)
  logger.info('New subscriber registered via private message', { userId, messageText })
  await trySendBotActivationWelcome(bot, chatId)
}

function buildMiniAppHomeUrl(): string {
  return buildBotStartappUrl('start')
}

/** MAX `bot_started` payload (tolerate alternate field names). */
function getBotStartPayload(ctx: Context): string {
  const u = ctx.update as { payload?: string | null; start_payload?: string | null }
  return (u.payload ?? u.start_payload ?? '').trim()
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

async function findRegisteredChannelsWhereUserIsAdmin(
  bot: Bot,
  userId: number,
): Promise<Array<{ chatId: number; title: string | null }>> {
  const channels = channelRegistry.getAllChannels().filter((c) => c.type === 'channel')
  channels.sort((a, b) => a.chat_id - b.chat_id)
  const out: Array<{ chatId: number; title: string | null }> = []
  for (const c of channels) {
    if (await isUserChannelAdmin(bot, c.chat_id, userId)) {
      out.push({ chatId: c.chat_id, title: c.title })
    }
  }
  return out
}

async function autoLinkAdminToRegisteredChannels(bot: Bot, userId: number): Promise<number[]> {
  const adminChannels = await findRegisteredChannelsWhereUserIsAdmin(bot, userId)
  if (adminChannels.length === 0) {
    return []
  }
  for (const ch of adminChannels) {
    settingsStore.linkUserToChannel(userId, ch.chatId)
  }
  subscriberStore.addSubscriber(userId)
  const linkedChatIds = adminChannels.map((ch) => ch.chatId)
  logger.info('autoLinkAdminToRegisteredChannels: linked admin to channels', {
    userId,
    linkedChatIds,
  })
  return linkedChatIds
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
 * Parses `/connect` with optional channel chat id.
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
  if (!Number.isFinite(channelId) || !Number.isInteger(channelId) || channelId === 0) {
    return undefined
  }
  return { mode: 'one', channelId }
}

/** Inline callback: подтвердить подключение канала (аналог `/connect <id>`). */
function buildConfirmChannelPayload(channelChatId: number): string {
  return `confirm_ch_${channelChatId}`
}

function parseConfirmChannelPayload(raw: string): number | null {
  const m = /^confirm_ch_(-?\d+)$/.exec(raw.trim())
  if (!m) {
    return null
  }
  const id = Number(m[1])
  return Number.isFinite(id) && Number.isInteger(id) && id !== 0 ? id : null
}

/**
 * Повторная проверка прав и финализация подключения (как `/connect`).
 * Возвращает строки для ответа пользователю.
 */
function resolveContextActorUserId(ctx: Context): number | undefined {
  const fromCtx = ctx.user?.user_id
  if (typeof fromCtx === 'number' && Number.isInteger(fromCtx) && fromCtx > 0) {
    return fromCtx
  }
  const fromCallback = ctx.callback?.user?.user_id
  if (typeof fromCallback === 'number' && Number.isInteger(fromCallback) && fromCallback > 0) {
    return fromCallback
  }
  return undefined
}

async function runChannelConnectAttempt(
  ctx: Context,
  bot: Bot,
  channelChatIds: number[],
): Promise<string[]> {
  const lines: string[] = []
  const actorUserId = resolveContextActorUserId(ctx)
  for (const channelChatId of channelChatIds) {
    const chatType = await fetchChatType(bot, channelChatId)
    const isChannelFlag = chatType === null ? true : chatType === 'channel'
    const outcome = await tryActivateChannelRegistration(ctx, bot, channelChatId, isChannelFlag, {
      skipNotifyUserIds: actorUserId != null ? [actorUserId] : undefined,
    })
    const regTitle = channelRegistry.getChannel(channelChatId)?.title ?? null
    const display = regTitle ? `«${regTitle}»` : `канал (номер чата: ${channelChatId})`
    if (outcome.status === 'registered') {
      lines.push(`✅ ${display} — подключение выполнено.`)
    } else if (outcome.status === 'reconnected') {
      lines.push(`✅ ${display} — канал снова подключён, кнопки комментариев обновляются.`)
    } else if (outcome.status === 'pending') {
      lines.push(
        `⏳ ${display} — пока нет прав администратора у бота или не удалось проверить доступ. Выдайте боту админ-права в канале и снова нажмите «Подтвердить подключение».`,
      )
    }
  }
  return lines
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
  | { status: 'reconnected' }
  | { status: 'pending'; shouldNotifyMissingAdmin: boolean }

type ChannelActivationOptions = {
  skipNotifyUserIds?: number[]
}

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

async function notifyAdminsChannelJoined(
  bot: Bot,
  channelChatId: number,
  skipUserIds?: ReadonlySet<number>,
): Promise<void> {
  const reg = channelRegistry.getChannel(channelChatId)
  const title = reg?.title ?? 'канал'
  const homeUrl = buildMiniAppHomeUrl()
  const message =
    `✅ Канал подключён\n\n` +
    `«${title}» успешно связан с CommentBot.\n\n` +
    `Под постами может появиться кнопка «Комментарии». Ответы на комментарии и настройки — в мини-приложении.`
  const kb = Keyboard.inlineKeyboard([[Keyboard.button.link('💬 Открыть панель управления', homeUrl)]])
  await notifyAllAdmins(bot, channelChatId, message, { attachments: [kb] }, skipUserIds)
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
  const joinUrl = buildBotJoinUrl(channelChatId, nick)
  const text =
    '👋 CommentBot подключён к каналу.\n\n' +
    'Администраторы: нажмите кнопку ниже, откройте чат с ботом и напишите любое сообщение — вы начнёте получать уведомления о комментариях.'
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
  options?: ChannelActivationOptions,
): Promise<ChannelActivationOutcome> {
  await ensureChannelPersisted(ctx, channelChatId, isChannel)

  const member = await fetchBotChatMemberWithRetry(bot, channelChatId)
  if (!member) {
    clearAdminJoinNotifiedForChannel(channelChatId)
    stateManager.markChannelPendingAdminRights(channelChatId)
    return { status: 'pending', shouldNotifyMissingAdmin: true }
  }
  if (!isBotAdminOrOwner(member)) {
    clearAdminJoinNotifiedForChannel(channelChatId)
    stateManager.markChannelPendingAdminRights(channelChatId)
    return { status: 'pending', shouldNotifyMissingAdmin: true }
  }

  stateManager.clearChannelPendingAdminRights(channelChatId)

  const wasConnectedBefore = hasChannelAdminJoinNotified(channelChatId)
  if (!wasConnectedBefore) {
    const skipNotify = new Set(options?.skipNotifyUserIds ?? [])
    await notifyAdminsChannelJoined(bot, channelChatId, skipNotify)
    markChannelAdminJoinNotified(channelChatId)
    void runChannelPollerForChat(bot, channelChatId)
    return { status: 'registered' }
  }

  logger.info('tryActivateChannelRegistration: reconnecting channel', { channelChatId })
  void runChannelPollerForChat(bot, channelChatId)
  return { status: 'reconnected' }
}

async function dmInviterAboutMissingAdmin(
  bot: Bot,
  inviterUserId: number | undefined,
  channelChatId: number,
  channelTitle: string | null,
): Promise<void> {
  const title = channelTitle ?? 'ваш канал'
  const text =
    `📢 Канал «${title}»\n\n` +
    `Вы добавили CommentBot в этот канал — спасибо.\n\n` +
    `Чтобы под постами появлялись комментарии, боту нужны права администратора в канале.\n\n` +
    `1. Откройте настройки канала → участники → выдайте боту роль администратора.\n` +
    `2. Нажмите кнопку ниже — я проверю доступ и завершу подключение.`

  const kb = Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✅ Подтвердить подключение', buildConfirmChannelPayload(channelChatId))],
  ])

  if (inviterUserId !== undefined) {
    await trySendDmToUser(bot, inviterUserId, text, { attachments: [kb] })
    return
  }

  logger.warn('dmInviterAboutMissingAdmin: no inviter user id; skipping DM', { channelChatId })
}

/** Уведомление админам канала: у бота сняли права администратора. */
async function notifyAdminsBotLostAdminRights(bot: Bot, channelChatId: number): Promise<void> {
  const reg = channelRegistry.getChannel(channelChatId)
  const title = reg?.title ?? (await fetchChatTitle(bot, channelChatId)) ?? 'ваш канал'
  const text =
    `⚠️ CommentBot больше не администратор канала\n\n` +
    `Канал: «${title}»\n\n` +
    `С бота сняли права администратора — бот не может выполнять свои функции: ` +
    `кнопки «Комментарии» под постами, уведомления и модерация временно недоступны.\n\n` +
    `Чтобы продолжить работу, откройте настройки канала → участники и снова назначьте CommentBot администратором.\n` +
    `После этого нажмите кнопку ниже — я проверю доступ и возобновлю работу.`

  const kb = Keyboard.inlineKeyboard([
    [Keyboard.button.callback('✅ Подтвердить подключение', buildConfirmChannelPayload(channelChatId))],
  ])

  await notifyAllAdmins(bot, channelChatId, text, { attachments: [kb] })
}

type BotDisconnectReason = 'bot_removed' | 'admin_rights_removed'

/**
 * Бот удалён из канала — полная очистка БД и сброс пользователей без других каналов.
 * Снятие только прав админа (бот ещё в канале) — помечаем «ожидает прав», данные не трогаем.
 */
async function handleBotDisconnected(
  bot: Bot,
  chatId: number,
  reason: BotDisconnectReason,
): Promise<void> {
  if (reason === 'bot_removed') {
    logger.info('handleBotDisconnected: bot removed from channel, full purge', { chatId })
    await fullyDisconnectRegisteredChannel(bot, chatId, 'removed_from_chat')
    return
  }

  const member = await fetchBotChatMember(bot, chatId)
  if (!member) {
    logger.info('handleBotDisconnected: bot no longer in channel, full purge', { chatId })
    await fullyDisconnectRegisteredChannel(bot, chatId, 'removed_from_chat')
    return
  }

  logger.info('handleBotDisconnected: bot lost admin only, pending rights', { chatId })
  clearAdminJoinNotifiedForChannel(chatId)
  stateManager.markChannelPendingAdminRights(chatId)
  try {
    await notifyAdminsBotLostAdminRights(bot, chatId)
  } catch (err: unknown) {
    logger.warn('handleBotDisconnected: notifyAdminsBotLostAdminRights failed', { chatId, err })
  }
}

export { clearAdminJoinNotifiedForChannel } from '../services/channelAdminJoinNotified'

export function registerEventHandlers(bot: Bot): void {
  bot.on('bot_added', async (ctx) => {
    const { chat_id: channelChatId, is_channel: isChannel } = ctx.update
    logger.info(`bot_added: chat_id=${channelChatId}`)

    const outcome = await tryActivateChannelRegistration(ctx, bot, channelChatId, isChannel)
    const inviterUserId = resolveInviterUserId(ctx.update.update_type, ctx.user, undefined)
    if (inviterUserId) {
      settingsStore.linkUserToChannel(inviterUserId, channelChatId)
      subscriberStore.addSubscriber(inviterUserId)
      logger.info('bot_added: linked inviter as admin', { inviterUserId, channelChatId })
    }
    if (outcome.status === 'pending' && outcome.shouldNotifyMissingAdmin) {
      const inviter = resolveInviterUserId(ctx.update.update_type, ctx.user, undefined)
      const title = await fetchChatTitle(bot, channelChatId)
      await dmInviterAboutMissingAdmin(bot, inviter, channelChatId, title)
    }
  })

  bot.on('bot_removed', async (ctx) => {
    const { chat_id: channelChatId } = ctx.update
    logger.info(`bot_removed: chat_id=${channelChatId}`)
    await handleBotDisconnected(bot, channelChatId, 'bot_removed')
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
    const inRegistry = channelRegistry.getChannel(channelChatId) !== null
    logger.info(`user_added (self): chat_id=${channelChatId}`, { inRegistry })

    const outcome = await tryActivateChannelRegistration(ctx, bot, channelChatId, isChannel)
    if (outcome.status === 'pending' && outcome.shouldNotifyMissingAdmin) {
      const inviter = resolveInviterUserId(ctx.update.update_type, ctx.user, inviterId)
      const title = await fetchChatTitle(bot, channelChatId)
      await dmInviterAboutMissingAdmin(bot, inviter, channelChatId, title)
    }
  })

  /**
   * Бот снят с роли или удалён как участник: частичное отключение (только реестр + уведомления).
   * Если придёт и `bot_removed`, второй вызов не сделает ничего — канала уже нет в реестре.
   */
  bot.on('user_removed', async (ctx) => {
    const { chat_id: channelChatId } = ctx.update
    const removedUserId = ctx.user?.user_id
    const botNumericId = ctx.myId
    if (
      removedUserId === undefined ||
      botNumericId === undefined ||
      removedUserId !== botNumericId
    ) {
      return
    }
    logger.info(`user_removed (bot): chat_id=${channelChatId}`)
    await handleBotDisconnected(bot, channelChatId, 'admin_rights_removed')
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
      logger.info('bot_started: payload detected', {
        userId: ctx.user?.user_id,
        payload: startPayload,
        isJoin: startPayload.startsWith('join'),
        parsedChatId: startPayload.startsWith('join') ? '-' + startPayload.slice(4) : null,
      })

      if (!userId) {
        return
      }

      if (startPayload === '' && settingsStore.getLinkedChannels(userId).length === 0) {
        await autoLinkAdminToRegisteredChannels(bot, userId)
      }

      const chatId = ctx.chatId
      const alreadyRegistered = subscriberStore.hasSubscriber(userId)

      if (chatId !== undefined) {
        stateManager.setUserPrivateChatId(userId, chatId)
      }

      if (!alreadyRegistered) {
        subscriberStore.addSubscriber(userId)
        logger.info('Subscriber registered via bot_started', { userId, payload: startPayload })
      }

      // Mini App opened from channel post — silent registration only
      if (startPayload.startsWith('pid_')) {
        const m = startPayload.match(/^pid_[a-f0-9]+_cid_(\d+)/)
        if (m) {
          const channelChatId = -Number.parseInt(m[1]!, 10)
          logger.info('bot_started: linked to channel via post', { userId, chatId: channelChatId })
        }
        return
      }

      // Comments gate: `?startapp=sub_<userId>` or `?start=sub_<userId>`
      if (/^sub_\d+$/i.test(startPayload)) {
        if (!alreadyRegistered && chatId !== undefined) {
          await trySendBotActivationWelcome(bot, chatId)
        } else if (!alreadyRegistered) {
          await trySendDmToUser(bot, userId, BOT_ACTIVATION_WELCOME_TEXT)
        }
        return
      }

      if (isAccountPairStartPayload(startPayload)) {
        try {
          await completeAccountPairingFromMax(startPayload, {
            platform: 'max',
            platformUserId: userId,
            username: ctx.user?.username ?? null,
            firstName: ctx.user?.name ?? null,
            lastName: null,
            photoUrl: null,
          })
          const homeUrl = buildMiniAppHomeUrl()
          const text =
            '✅ MAX привязан к вашему Telegram-аккаунту!\n\n' +
            'Команда канала увидит связку в списке админов. Откройте мини-приложение в MAX.'
          const kb = Keyboard.inlineKeyboard([
            [Keyboard.button.link('💬 Открыть панель', homeUrl)],
          ])
          if (chatId !== undefined) {
            await bot.api.sendMessageToChat(chatId, text, { attachments: [kb] })
          } else {
            await bot.api.sendMessageToUser(userId, text, { attachments: [kb] })
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          let text = 'Не удалось привязать MAX. Создайте новую ссылку в Telegram.'
          if (msg === 'pairing token expired') {
            text = 'Ссылка устарела. В Telegram нажмите «Связать MAX» ещё раз.'
          } else if (msg === 'pairing token already used') {
            text = 'Ссылка уже использована.'
          }
          if (chatId !== undefined) {
            await bot.api.sendMessageToChat(chatId, text)
          } else {
            await trySendDmToUser(bot, userId, text)
          }
        }
        return
      }

      // Admin invite: `?start=join<abs(channelId)>` — link immediately, no Mini App / admin API check
      if (startPayload.toLowerCase().startsWith('join')) {
        const channelChatId = resolveChannelChatIdFromInviteParam(startPayload)
        if (!channelChatId) {
          logger.warn('bot_started: invalid join payload', { userId, payload: startPayload })
          return
        }

        logger.info('bot_started: join payload detected', { userId, channelChatId, payload: startPayload })

        stateManager.setPendingAdminJoin(userId, channelChatId)
        subscriberStore.addSubscriber(userId)
        settingsStore.linkUserToChannel(userId, channelChatId)

        const channel = channelRegistry.getChannel(channelChatId)
        const title = channel?.title ?? `ID ${channelChatId}`

        const confirmText =
          `✅ Готово! Вы подключены к каналу «${title}».\n\n` +
          `Теперь вы будете получать уведомления о новых комментариях.\n\n` +
          `Когда подписчики пишут комментарии — вы получите сообщение ` +
          `с текстом комментария и кнопкой для ответа от имени канала.`

        try {
          await bot.api.sendMessageToUser(userId, confirmText)
        } catch (err: unknown) {
          if (chatId !== undefined) {
            await bot.api.sendMessageToChat(chatId, confirmText)
          } else {
            logger.warn('bot_started: join confirm send failed', { userId, channelChatId, err })
          }
        }

        stateManager.clearPendingAdminJoinForUser(userId)
        logger.info('bot_started: admin linked to channel', { userId, channelChatId, title })
        return
      }

      if (chatId === undefined) {
        logger.warn('bot_started: нет chat_id в контексте')
        return
      }

      const firstBotStart = !alreadyRegistered
      const firstName = ctx.user?.name || 'пользователь'

      const homeUrl = buildMiniAppHomeUrl()

      const sendUser = async (text: string, kb: ReturnType<typeof Keyboard.inlineKeyboard>): Promise<void> => {
        await bot.api.sendMessageToUser(userId, text, { attachments: [kb] })
      }

      // 1) Subscriber deep link
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

      if (rawPayload === MAX_BOOKED_IN_TG_CALLBACK) {
        return
      }

      const confirmChannelId = parseConfirmChannelPayload(rawPayload)
      if (confirmChannelId !== null) {
        const lines = await runChannelConnectAttempt(ctx, bot, [confirmChannelId])
        try {
          await bot.api.sendMessageToUser(userId, lines.join('\n'))
        } catch (e: unknown) {
          logger.warn('message_callback: confirm_ch reply failed', { userId, confirmChannelId, e })
        }
        return
      }

      const linkCode = parseConfirmChannelLinkPayload(rawPayload)
      if (linkCode !== null) {
        try {
          const result = await finalizeChannelLinkDraftInMax(bot, linkCode, userId)
          const maxT = result.chain.max_title ?? 'MAX'
          const tgT = result.chain.tg_title ?? 'Telegram'
          await bot.api.sendMessageToUser(
            userId,
            `✅ Связка создана!\n\n📱 ${tgT} → 📺 ${maxT}\n\nПосты из Telegram будут пересылаться в MAX.`,
          )
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          let userText = 'Не удалось подтвердить связку. Попробуйте создать новый код в мини-приложении.'
          if (msg === 'forbidden') {
            userText = 'Подтвердить связку может только тот, кто создал код в MAX.'
          } else if (msg === 'code expired' || msg === 'invalid code') {
            userText = 'Код истёк или не найден. Создайте новый код в MAX.'
          } else if (msg === 'not awaiting confirm') {
            userText = 'Эта связка уже подтверждена или код больше не действует.'
          } else if (msg === 'pair already linked') {
            userText = 'Такая связка уже существует.'
          }
          try {
            await bot.api.sendMessageToUser(userId, userText)
          } catch (e: unknown) {
            logger.warn('message_callback: confirm_link reply failed', { userId, linkCode, e })
          }
          logger.warn('message_callback: confirm_link failed', { userId, linkCode, err })
        }
        return
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
        const inviteUrl = buildBotJoinUrl(ch.chatId, nick)
        const tgInviteUrl = buildTelegramNotifyInviteUrlForMaxChannel(ch.chatId)
        let inviteText =
          `Отправьте ссылку администраторам канала «${channelTitle}».\n\n` +
          `В MAX (есть аккаунт в MAX):\n${inviteUrl}\n\n` +
          `После перехода человек откроет бота MAX и начнёт получать уведомления о комментариях.`
        if (tgInviteUrl) {
          inviteText +=
            `\n\nТолько Telegram (нет в MAX, но админ TG-канала):\n${tgInviteUrl}\n\n` +
            `После Start в Telegram-боте — те же уведомления и ответы из Telegram.`
        }
        await bot.api.sendMessageToUser(userId, inviteText)
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
    const text = message.body.text?.trim() ?? ''
    const isPrivateDialog = message.recipient?.chat_type === 'dialog'

    logger.info('message_created received', {
      chatType: message.recipient?.chat_type,
      userId: user.user_id,
      isPrivate: isPrivateDialog,
      text: text.slice(0, 30),
    })

    if (
      isPrivateDialog &&
      !/^\/addbutton\b/i.test(text) &&
      !/^\/connect\b/i.test(text)
    ) {
      const pendingChannelId = stateManager.getPendingAdminJoin(user.user_id)
      if (pendingChannelId !== undefined) {
        stateManager.clearPendingAdminJoinForUser(user.user_id)
        settingsStore.linkUserToChannel(user.user_id, pendingChannelId)
        subscriberStore.addSubscriber(user.user_id)

        const channel = channelRegistry.getChannel(pendingChannelId)
        const title = channel?.title ?? `ID ${pendingChannelId}`

        try {
          await bot.api.sendMessageToChat(
            chatId,
            `✅ Вы подключены к каналу «${title}»!\n\n` +
              `Теперь вы будете получать уведомления о новых комментариях.`,
          )
        } catch (err: unknown) {
          logger.warn('message_created: pending admin join confirm failed', {
            userId: user.user_id,
            pendingChannelId,
            err,
          })
        }
        logger.info('message_created: admin linked from pending join', {
          userId: user.user_id,
          channelChatId: pendingChannelId,
        })
        return
      }

      if (settingsStore.getLinkedChannels(user.user_id).length === 0) {
        const linkedChatIds = await autoLinkAdminToRegisteredChannels(bot, user.user_id)
        if (linkedChatIds.length > 0) {
          logger.info('message_created: auto-linked admin from private dialog', {
            userId: user.user_id,
            linkedChatIds,
          })
        }
      }
      await handlePrivateChatMessage(bot, message, user)
      return
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
        source: 'manual',
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
      if (r.reason === 'attach_failed') {
        await ctx.reply(
          'Could not attach the button (MAX API rejected edit/reply). Check bot admin rights and try «Обновить кнопки» in the admin panel.',
        )
        return
      }
      await ctx.reply(`Could not add the button (${r.reason}).`)
      return
    }

    const registered = lookupRegisteredChannelForMessage(message)
    if (registered) {
      const mid = message.body.mid
      logger.info('message_created: registered channel post', {
        chatId: registered.chatId,
        messageMid: mid,
        title: registered.title,
      })
      const r = await tryAttachCommentsToChannelPost(bot, message, {
        botUserId: ctx.myId,
        channelChatIdOverride: registered.chatId,
        skipAuthorAdminCheck: true,
        source: 'webhook',
      })
      if (!r.ok && mid) {
        if (r.reason === 'attach_failed') {
          scheduleCommentButtonRetry(registered.chatId, mid)
        }
        logger.info('message_created: кнопка не присвоена (см. commentButton / retry)', {
          messageMid: mid,
          reason: r.reason,
        })
      }
      scheduleVkForwardForMaxChannelPost(
        registered.chatId,
        message,
        r.ok ? undefined : r.reason,
        ctx.myId,
      )
      return
    }

    const channelLikely = await isLikelyChannelPost(bot, message)
    if (channelLikely) {
      logger.info('message_created: channel-shaped message (not in registry)', {
        chatId,
        recipientChatType: message.recipient.chat_type,
        messageMid: message.body.mid,
      })
      const r = await tryAttachCommentsToChannelPost(bot, message, {
        botUserId: ctx.myId,
        skipAuthorAdminCheck: true,
        source: 'webhook',
      })
      if (!r.ok) {
        logger.info('message_created: кнопка не присвоена (см. commentButton выше)', {
          messageMid: message.body.mid,
          reason: r.reason,
        })
      }
      scheduleVkForwardForMaxChannelPost(chatId, message, r.ok ? undefined : r.reason, ctx.myId)
      return
    }

    const parsedConnect = parseConnectCommand(text)
    if (parsedConnect === undefined) {
      await ctx.reply('Команда /connect: без параметров — проверить все каналы в ожидании; с числом — номер чата нужного канала.')
      return
    }
    if (parsedConnect !== false) {
      let currentChat: Chat
      try {
        currentChat = await ctx.api.getChat(chatId)
      } catch (err: unknown) {
        logger.warn('message_created /connect: getChat failed', { chatId, err })
        await ctx.reply('Не удалось загрузить чат. Попробуйте позже.')
        return
      }
      if (currentChat.type !== 'dialog') {
        await ctx.reply('Команда /connect работает только в личном чате с ботом.')
        return
      }
      const targets: number[] =
        parsedConnect.mode === 'one'
          ? [parsedConnect.channelId]
          : stateManager.getPendingAdminChannelIds()

      if (targets.length === 0) {
        await ctx.reply(
          'Нет каналов, ожидающих подключения. Сначала добавьте бота в канал (и при необходимости выдайте права администратора).',
        )
        return
      }

      const lines = await runChannelConnectAttempt(ctx, bot, targets)
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
