import axios from 'axios'

import { integrationsStore } from './integrationsStore'
import { listTelegramChatAdministrators } from './integrationPlatformClient'
import { telegramBotUserStore } from './telegramBotUserStore'
import { telegramChannelNotifyLinkStore } from './telegramChannelNotifyLinkStore'
import { telegramChannelRegistry } from './telegramChannelRegistry'
import {
  clearTelegramAdminJoinNotified,
  hasTelegramAdminJoinNotified,
  markTelegramAdminJoinNotified,
} from './telegramChannelAdminJoinNotified'
import { telegramChannelActivationState } from './telegramChannelActivationState'
import { getTelegramToken } from '../config'
import {
  buildTelegramBotJoinUrl,
  buildTelegramConfirmChannelPayload,
  parseTelegramConfirmChannelPayload,
  parseTelegramConnectCommand,
} from '../utils/telegramDeeplink'
import { logger } from '../utils/logger'

const TG_API = 'https://api.telegram.org/bot'

let cachedBotUserId: number | null = null

type TelegramActivationOutcome =
  | { status: 'registered' }
  | { status: 'reconnected' }
  | { status: 'pending'; shouldNotifyMissingAdmin: boolean }

function resolveTelegramBotToken(): string {
  const integ = integrationsStore.getTelegramIntegration()
  const fromInteg = integ?.token?.trim() ?? ''
  if (fromInteg) {
    return fromInteg
  }
  return getTelegramToken().trim()
}

async function sendTelegramBotMessage(
  token: string,
  chatId: number | string,
  text: string,
  extra?: { reply_markup?: unknown },
): Promise<void> {
  await axios.post(
    `${TG_API}${token}/sendMessage`,
    {
      chat_id: chatId,
      text,
      ...(extra?.reply_markup ? { reply_markup: extra.reply_markup } : {}),
    },
    { timeout: 15_000 },
  )
}

async function answerTelegramCallbackQuery(
  token: string,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await axios.post(
    `${TG_API}${token}/answerCallbackQuery`,
    {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    },
    { timeout: 10_000 },
  )
}

async function getBotTelegramUserId(token: string): Promise<number | null> {
  if (cachedBotUserId != null) {
    return cachedBotUserId
  }
  try {
    const { data } = await axios.get<{ ok: boolean; result?: { id?: number } }>(
      `${TG_API}${token}/getMe`,
      { timeout: 10_000 },
    )
    const id = data.result?.id
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) {
      cachedBotUserId = id
      return id
    }
  } catch (err: unknown) {
    logger.warn('getBotTelegramUserId: getMe failed', { err })
  }
  return null
}

async function isBotTelegramChannelAdmin(token: string, channelChatId: string): Promise<boolean> {
  const botId = await getBotTelegramUserId(token)
  if (botId == null) {
    return false
  }
  try {
    const { data } = await axios.get<{
      ok: boolean
      result?: { status?: string }
    }>(`${TG_API}${token}/getChatMember`, {
      params: { chat_id: channelChatId, user_id: botId },
      timeout: 15_000,
    })
    const status = data.result?.status ?? ''
    return status === 'administrator' || status === 'creator'
  } catch (err: unknown) {
    logger.warn('isBotTelegramChannelAdmin: getChatMember failed', { channelChatId, err })
    return false
  }
}

function parseInviterUserId(mcm: Record<string, unknown>): number | undefined {
  const from = mcm.from as Record<string, unknown> | undefined
  const id = from?.id
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : undefined
}

function extractChatMeta(chat: Record<string, unknown>): {
  chatId: string
  title: string | null
  username: string | null
  chatType: string
} {
  const chatId = String(chat.id)
  const chatType = typeof chat.type === 'string' ? chat.type : 'channel'
  const title =
    typeof chat.title === 'string' && chat.title.trim() !== '' ? chat.title.trim() : null
  const username =
    typeof chat.username === 'string' && chat.username.trim() !== ''
      ? `@${chat.username.replace(/^@/, '')}`
      : null
  return { chatId, title, username, chatType }
}

async function postTelegramChannelAdminInvite(channelChatId: string): Promise<void> {
  const token = resolveTelegramBotToken()
  if (!token) {
    return
  }
  const joinUrl = buildTelegramBotJoinUrl(channelChatId)
  const text =
    '👋 CommentBot подключён к каналу.\n\n' +
    'Администраторы: нажмите кнопку ниже, откройте чат с ботом и напишите любое сообщение — вы начнёте получать уведомления о комментариях.'
  try {
    await sendTelegramBotMessage(token, channelChatId, text, {
      reply_markup: {
        inline_keyboard: [[{ text: '🔔 Получать уведомления о комментариях', url: joinUrl }]],
      },
    })
  } catch (err: unknown) {
    logger.warn('postTelegramChannelAdminInvite: send failed', { channelChatId, err })
  }
}

async function notifyTelegramChannelJoined(channelChatId: string): Promise<void> {
  const token = resolveTelegramBotToken()
  if (!token) {
    return
  }
  const reg = telegramChannelRegistry.getChannel(channelChatId)
  const title = reg?.title ?? 'канал'
  const homeUrl = process.env.MINI_APP_URL?.trim() || 'https://t.me/commentvmax_bot'
  const admins = await listTelegramChatAdministrators(token, channelChatId)
  const message =
    `✅ Канал подключён\n\n` +
    `«${title}» успешно связан с CommentBot в Telegram.\n\n` +
    `Подключите уведомления и настройки в мини-приложении.`
  const keyboard = {
    inline_keyboard: [[{ text: '💬 Открыть панель управления', url: homeUrl }]],
  }
  for (const admin of admins) {
    if (!admin.startedBot) {
      continue
    }
    try {
      await sendTelegramBotMessage(token, admin.userId, message, { reply_markup: keyboard })
    } catch (err: unknown) {
      logger.warn('notifyTelegramChannelJoined: send failed', {
        channelChatId,
        adminId: admin.userId,
        err,
      })
    }
  }
}

async function notifyTelegramAdminsBotLostAdminRights(channelChatId: string): Promise<void> {
  const token = resolveTelegramBotToken()
  if (!token) {
    return
  }
  const reg = telegramChannelRegistry.getChannel(channelChatId)
  const title = reg?.title ?? 'ваш канал'
  const text =
    `⚠️ CommentBot больше не администратор канала\n\n` +
    `Канал: «${title}»\n\n` +
    `С бота сняли права администратора — уведомления и интеграция временно недоступны.\n\n` +
    `Чтобы продолжить, снова назначьте @commentvmax_bot администратором канала и нажмите «Подтвердить подключение» в личке с ботом.`
  const confirmPayload = buildTelegramConfirmChannelPayload(channelChatId)
  const keyboard = {
    inline_keyboard: [[{ text: '✅ Подтвердить подключение', callback_data: confirmPayload }]],
  }
  const admins = await listTelegramChatAdministrators(token, channelChatId)
  for (const admin of admins) {
    if (!admin.startedBot) {
      continue
    }
    try {
      await sendTelegramBotMessage(token, admin.userId, text, { reply_markup: keyboard })
    } catch (err: unknown) {
      logger.warn('notifyTelegramAdminsBotLostAdminRights: send failed', {
        channelChatId,
        adminId: admin.userId,
        err,
      })
    }
  }
}

async function dmTelegramInviterAboutMissingAdmin(
  inviterUserId: number | undefined,
  channelChatId: string,
  channelTitle: string | null,
): Promise<void> {
  if (inviterUserId == null) {
    return
  }
  const token = resolveTelegramBotToken()
  const title = channelTitle ?? 'ваш канал'
  const text =
    `📢 Канал «${title}»\n\n` +
    `Вы добавили CommentBot в этот канал — спасибо.\n\n` +
    `Чтобы бот мог работать с каналом, ему нужны права администратора.\n\n` +
    `1. Откройте настройки канала → администраторы → выдайте @commentvmax_bot права админа.\n` +
    `2. Нажмите кнопку ниже — я проверю доступ и завершу подключение.`
  const keyboard = {
    inline_keyboard: [
      [
        {
          text: '✅ Подтвердить подключение',
          callback_data: buildTelegramConfirmChannelPayload(channelChatId),
        },
      ],
    ],
  }
  try {
    await sendTelegramBotMessage(token, inviterUserId, text, { reply_markup: keyboard })
  } catch (err: unknown) {
    logger.warn('dmTelegramInviterAboutMissingAdmin: send failed', {
      inviterUserId,
      channelChatId,
      err,
    })
  }
}

function linkInviterAsAdmin(inviterUserId: number | undefined, channelChatId: string): void {
  if (inviterUserId == null) {
    return
  }
  telegramBotUserStore.markStarted({ id: inviterUserId })
  telegramChannelNotifyLinkStore.register(inviterUserId, channelChatId)
}

export async function tryActivateTelegramChannelRegistration(
  channelChatId: string,
  inviterUserId?: number,
): Promise<TelegramActivationOutcome> {
  const token = resolveTelegramBotToken()
  if (!token) {
    return { status: 'pending', shouldNotifyMissingAdmin: false }
  }

  const reg = telegramChannelRegistry.getChannel(channelChatId)
  const botIsAdmin = await isBotTelegramChannelAdmin(token, channelChatId)

  telegramChannelRegistry.saveChannel({
    chatId: channelChatId,
    title: reg?.title ?? null,
    username: reg?.username ?? null,
    type: reg?.type ?? 'channel',
    botIsAdmin,
  })

  if (!botIsAdmin) {
    clearTelegramAdminJoinNotified(channelChatId)
    telegramChannelActivationState.markChannelPendingAdminRights(channelChatId)
    return { status: 'pending', shouldNotifyMissingAdmin: true }
  }

  telegramChannelActivationState.clearChannelPendingAdminRights(channelChatId)
  linkInviterAsAdmin(inviterUserId, channelChatId)

  const wasConnectedBefore = hasTelegramAdminJoinNotified(channelChatId)
  if (!wasConnectedBefore) {
    await notifyTelegramChannelJoined(channelChatId)
    await postTelegramChannelAdminInvite(channelChatId)
    markTelegramAdminJoinNotified(channelChatId)
    logger.info('telegramChannelActivation: channel registered', { channelChatId, inviterUserId })
    return { status: 'registered' }
  }

  logger.info('telegramChannelActivation: channel reconnected', { channelChatId })
  return { status: 'reconnected' }
}

export async function runTelegramChannelConnectAttempt(
  channelChatIds: string[],
  actorUserId?: number,
): Promise<string[]> {
  const lines: string[] = []
  for (const channelChatId of channelChatIds) {
    const outcome = await tryActivateTelegramChannelRegistration(channelChatId, actorUserId)
    const reg = telegramChannelRegistry.getChannel(channelChatId)
    const display = reg?.title ? `«${reg.title}»` : `канал ${channelChatId}`
    if (outcome.status === 'registered') {
      lines.push(`✅ ${display} — подключение выполнено.`)
    } else if (outcome.status === 'reconnected') {
      lines.push(`✅ ${display} — канал снова подключён.`)
    } else {
      lines.push(
        `⏳ ${display} — пока нет прав администратора у бота. Выдайте @commentvmax_bot права админа в канале и снова нажмите «Подтвердить подключение» или отправьте /connect.`,
      )
    }
  }
  return lines
}

export async function handleTelegramMyChatMemberUpdate(
  update: Record<string, unknown>,
): Promise<void> {
  const mcm = update.my_chat_member as Record<string, unknown> | undefined
  if (!mcm) {
    return
  }
  const chat = mcm.chat as Record<string, unknown> | undefined
  const newMember = mcm.new_chat_member as Record<string, unknown> | undefined
  const oldMember = mcm.old_chat_member as Record<string, unknown> | undefined
  const newStatus = typeof newMember?.status === 'string' ? newMember.status : ''
  const oldStatus = typeof oldMember?.status === 'string' ? oldMember.status : ''
  if (!chat) {
    return
  }
  const { chatId, title, username, chatType } = extractChatMeta(chat)
  if (chatType !== 'channel' && chatType !== 'supergroup') {
    return
  }

  const inviterUserId = parseInviterUserId(mcm)
  const wasAdmin = telegramChannelRegistry.getChannel(chatId)?.bot_is_admin === true
  const isAdminNow = newStatus === 'administrator' || newStatus === 'creator'
  const isMemberNow = isAdminNow || newStatus === 'member'
  const isRemoved = newStatus === 'left' || newStatus === 'kicked' || newStatus === 'restricted'

  logger.info('telegram my_chat_member', {
    chatId,
    oldStatus,
    newStatus,
    inviterUserId,
  })

  if (isRemoved) {
    telegramChannelRegistry.saveChannel({
      chatId,
      title,
      username,
      type: chatType,
      botIsAdmin: false,
    })
    clearTelegramAdminJoinNotified(chatId)
    telegramChannelActivationState.markChannelPendingAdminRights(chatId)
    if (wasAdmin) {
      await notifyTelegramAdminsBotLostAdminRights(chatId)
    }
    return
  }

  if (!isMemberNow) {
    return
  }

  telegramChannelRegistry.saveChannel({
    chatId,
    title,
    username,
    type: chatType,
    botIsAdmin: isAdminNow,
  })

  if (inviterUserId != null) {
    telegramBotUserStore.markStarted({ id: inviterUserId })
  }

  const outcome = await tryActivateTelegramChannelRegistration(chatId, inviterUserId)

  if (outcome.status === 'pending' && outcome.shouldNotifyMissingAdmin) {
    const shouldDm =
      !isAdminNow &&
      (oldStatus === 'left' || oldStatus === 'kicked' || oldStatus === '' || !wasAdmin)
    if (shouldDm) {
      await dmTelegramInviterAboutMissingAdmin(inviterUserId, chatId, title)
    }
  }
}

export async function handleTelegramCallbackQuery(update: Record<string, unknown>): Promise<void> {
  const cq = update.callback_query as Record<string, unknown> | undefined
  if (!cq) {
    return
  }
  const token = resolveTelegramBotToken()
  const data = typeof cq.data === 'string' ? cq.data.trim() : ''
  const from = cq.from as Record<string, unknown> | undefined
  const userId = typeof from?.id === 'number' ? from.id : null
  const callbackId = typeof cq.id === 'string' ? cq.id : null
  if (!data || userId == null || !callbackId) {
    return
  }

  const channelChatId = parseTelegramConfirmChannelPayload(data)
  if (!channelChatId) {
    return
  }

  try {
    await answerTelegramCallbackQuery(token, callbackId)
  } catch (err: unknown) {
    logger.warn('handleTelegramCallbackQuery: answer failed', { err })
  }

  const lines = await runTelegramChannelConnectAttempt([channelChatId], userId)
  try {
    await sendTelegramBotMessage(token, userId, lines.join('\n'))
  } catch (err: unknown) {
    logger.warn('handleTelegramCallbackQuery: reply failed', { userId, channelChatId, err })
  }
}

export async function handleTelegramPrivateMessage(
  fromUserId: number,
  text: string,
): Promise<void> {
  const token = resolveTelegramBotToken()
  const trimmed = text.trim()

  const pendingJoin = telegramChannelActivationState.getPendingAdminJoin(fromUserId)
  if (pendingJoin && !trimmed.startsWith('/')) {
    telegramChannelActivationState.clearPendingAdminJoinForUser(fromUserId)
    telegramChannelNotifyLinkStore.register(fromUserId, pendingJoin)
    const title = telegramChannelRegistry.getChannel(pendingJoin)?.title ?? pendingJoin
    await sendTelegramBotMessage(
      token,
      fromUserId,
      `✅ Вы подключены к каналу «${title}»!\n\nТеперь вы будете получать уведомления о новых комментариях.`,
    )
    return
  }

  const parsedConnect = parseTelegramConnectCommand(trimmed)
  if (parsedConnect === false) {
    return
  }
  if (parsedConnect === undefined) {
    await sendTelegramBotMessage(
      token,
      fromUserId,
      'Команда /connect: без параметров — проверить все каналы в ожидании; с цифрами — ID канала (например /connect 1001234567890).',
    )
    return
  }
  {
    const targets =
      parsedConnect.mode === 'one'
        ? [parsedConnect.channelChatId]
        : telegramChannelActivationState.getPendingAdminChannelIds()
    if (targets.length === 0) {
      await sendTelegramBotMessage(
        token,
        fromUserId,
        'Нет каналов, ожидающих подключения. Сначала добавьте @commentvmax_bot в канал (и выдайте права администратора).',
      )
      return
    }
    const lines = await runTelegramChannelConnectAttempt(targets, fromUserId)
    await sendTelegramBotMessage(token, fromUserId, lines.join('\n'))
  }
}
