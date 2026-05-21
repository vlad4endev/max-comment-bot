import axios from 'axios'

import { getTelegramToken } from '../config'
import { integrationsStore } from './integrationsStore'
import {
  enrichTelegramChatsWithBotAdmin,
  listTelegramBotChats,
  listTelegramChatAdministrators,
} from './integrationPlatformClient'
import { telegramBotUserStore } from './telegramBotUserStore'
import { telegramChannelNotifyLinkStore } from './telegramChannelNotifyLinkStore'
import { telegramChannelRegistry } from './telegramChannelRegistry'
import { commentStore } from './commentStore'
import { postStore } from './postStore'
import { ensureAdminPanelStateLoaded, listTgChainsSync } from '../api/adminPanelState'
import { buildTelegramBotJoinUrl } from '../utils/telegramDeeplink'
import {
  handleTelegramCallbackQuery,
  handleTelegramMyChatMemberUpdate,
  handleTelegramPrivateMessage,
} from './telegramChannelActivation'
import { logger } from '../utils/logger'

const TG_API = 'https://api.telegram.org/bot'

export interface TelegramMiniappChannelWire {
  chat_id: string
  title: string | null
  subscribers: number | null
  avatar_url: string | null
  status: 'pending' | 'active'
  platform: 'telegram'
}

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

async function isTelegramChannelAdmin(
  token: string,
  channelChatId: string,
  telegramUserId: number,
): Promise<boolean> {
  const admins = await listTelegramChatAdministrators(token, channelChatId)
  return admins.some((a) => a.userId === telegramUserId)
}

async function refreshTelegramChannelsCache(token: string): Promise<void> {
  const integration = integrationsStore.getTelegramIntegration()
  const discovered = await listTelegramBotChats(token, integration?.id)
  const enriched = await enrichTelegramChatsWithBotAdmin(token, discovered)
  for (const ch of enriched) {
    if (ch.type !== 'channel' && ch.type !== 'supergroup') {
      continue
    }
    telegramChannelRegistry.saveChannel({
      chatId: ch.id,
      title: ch.title,
      username: ch.username,
      type: ch.type,
      botIsAdmin: ch.botIsAdmin === true,
    })
  }
}

export async function listTelegramMiniappChannelsForUser(
  telegramUserId: number,
): Promise<{ channels: TelegramMiniappChannelWire[]; bot_username: string }> {
  const token = resolveTelegramBotToken()
  if (!token) {
    return { channels: [], bot_username: 'commentvmax_bot' }
  }
  await integrationsStore.load()
  await refreshTelegramChannelsCache(token)

  const registryRows = telegramChannelRegistry.getAllChannels()
  const channels: TelegramMiniappChannelWire[] = []

  for (const row of registryRows) {
    if (row.type !== 'channel' && row.type !== 'supergroup') {
      continue
    }
    if (!(await isTelegramChannelAdmin(token, row.chat_id, telegramUserId))) {
      continue
    }
    channels.push({
      chat_id: row.chat_id,
      title: row.title,
      subscribers: null,
      avatar_url: null,
      status: row.bot_is_admin ? 'active' : 'pending',
      platform: 'telegram',
    })
  }

  return { channels, bot_username: 'commentvmax_bot' }
}

export async function getTelegramMiniappStats(telegramUserId: number): Promise<{
  channels: number
  posts: number
  comments: number
  bot_nickname: string
}> {
  const { channels } = await listTelegramMiniappChannelsForUser(telegramUserId)
  await ensureAdminPanelStateLoaded()
  const chains = listTgChainsSync().filter((c) => c.active)
  const adminTgIds = new Set(channels.map((c) => c.chat_id))
  const postIds = new Set<string>()
  let posts = 0

  for (const chain of chains) {
    const tgId = chain.tg_channel_id?.trim()
    if (!tgId || !adminTgIds.has(tgId)) {
      continue
    }
    const maxChatId = chain.max_chat_id
    const list = postStore.getPostsByChatId(maxChatId)
    posts += list.length
    for (const p of list) {
      postIds.add(p.post_id)
    }
  }

  return {
    channels: channels.length,
    posts,
    comments: commentStore.countForPostIds(postIds),
    bot_nickname: 'commentvmax_bot',
  }
}

export async function getTelegramChannelAdminsForMiniapp(
  telegramUserId: number,
  channelChatId: string,
): Promise<{
  admins: Array<{
    user_id: number
    name: string
    initials: string
    linked: boolean
  }>
  invite_url: string
}> {
  const token = resolveTelegramBotToken()
  const chatId = String(channelChatId).trim()
  const reg = telegramChannelRegistry.getChannel(chatId)
  if (!reg) {
    throw new Error('channel not connected')
  }
  if (!(await isTelegramChannelAdmin(token, chatId, telegramUserId))) {
    throw new Error('forbidden')
  }

  const rows = await listTelegramChatAdministrators(token, chatId)
  const linkedIds = new Set(telegramChannelNotifyLinkStore.getUserIdsForChannel(chatId))
  const admins = rows.map((a) => {
    const name = a.name
    const initials =
      name.trim().length >= 2
        ? name
            .trim()
            .split(/\s+/)
            .map((p) => p[0])
            .join('')
            .slice(0, 2)
            .toUpperCase()
        : name.slice(0, 2).toUpperCase()
    return {
      user_id: a.userId,
      name,
      initials,
      linked: linkedIds.has(a.userId),
    }
  })

  return {
    admins,
    invite_url: buildTelegramBotJoinUrl(chatId),
  }
}

export async function resolveTelegramChannelInviteAccess(
  telegramUserId: number,
  joinChannelIdRaw: string,
): Promise<
  | { ok: true; channelChatId: string; title: string | null }
  | { ok: false; status: 400 | 404; error: string }
> {
  const chatId = String(joinChannelIdRaw).trim()
  if (!/^-?\d+$/.test(chatId)) {
    return { ok: false, status: 400, error: 'missing or invalid join_channel_id' }
  }
  const reg = telegramChannelRegistry.getChannel(chatId)
  if (!reg) {
    return { ok: false, status: 404, error: 'channel is not connected to this bot' }
  }
  return { ok: true, channelChatId: chatId, title: reg.title }
}

export async function registerTelegramChannelNotifyLink(
  telegramUserId: number,
  channelChatId: string,
): Promise<{ channel_title: string | null; already_linked: boolean }> {
  const access = await resolveTelegramChannelInviteAccess(telegramUserId, channelChatId)
  if (!access.ok) {
    throw new Error(access.error)
  }
  const wasLinked = telegramChannelNotifyLinkStore.isLinked(telegramUserId, access.channelChatId)
  telegramChannelNotifyLinkStore.register(telegramUserId, access.channelChatId)
  telegramBotUserStore.markStarted({
    id: telegramUserId,
  })
  return {
    channel_title: access.title,
    already_linked: wasLinked,
  }
}

export async function handleTelegramBotStartJoin(
  telegramUserId: number,
  startPayload: string,
): Promise<void> {
  const token = resolveTelegramBotToken()
  const m = /^jointg(\d+)$/i.exec(String(startPayload).trim())
  const channelChatId = m ? `-${m[1]}` : ''
  if (!channelChatId) {
    return
  }
  const access = await resolveTelegramChannelInviteAccess(telegramUserId, channelChatId)
  if (!access.ok) {
    await sendTelegramBotMessage(
      token,
      telegramUserId,
      'Не удалось подключить канал. Убедитесь, что бот добавлен в канал как администратор.',
    )
    return
  }
  await registerTelegramChannelNotifyLink(telegramUserId, channelChatId)
  const title = access.title ?? 'канал'
  const text =
    `✅ Готово! Вы подключены к каналу «${title}».\n\n` +
    `Теперь вы будете получать уведомления о новых комментариях (в Telegram и в связанном MAX-канале).`
  await sendTelegramBotMessage(token, telegramUserId, text)
}

export async function handleTelegramMyChatMemberUpdate(
  update: Record<string, unknown>,
): Promise<void> {
  const mcm = update.my_chat_member as Record<string, unknown> | undefined
  if (!mcm) {
    return
  }
  const chat = mcm.chat as Record<string, unknown> | undefined
  const member = mcm.new_chat_member as Record<string, unknown> | undefined
  const status = typeof member?.status === 'string' ? member.status : ''
  if (!chat || typeof chat.id !== 'number' && typeof chat.id !== 'string') {
    return
  }
  const chatId = String(chat.id)
  const chatType = typeof chat.type === 'string' ? chat.type : 'channel'
  if (chatType !== 'channel' && chatType !== 'supergroup') {
    return
  }
  const isAdmin = status === 'administrator' || status === 'creator'
  const isMember = isAdmin || status === 'member'
  if (!isMember) {
    telegramChannelRegistry.saveChannel({
      chatId,
      title: typeof chat.title === 'string' ? chat.title : null,
      username: typeof chat.username === 'string' ? `@${chat.username}` : null,
      type: chatType,
      botIsAdmin: false,
    })
    return
  }

  const title =
    typeof chat.title === 'string' && chat.title.trim() !== '' ? chat.title.trim() : null
  const username =
    typeof chat.username === 'string' && chat.username.trim() !== ''
      ? `@${chat.username.replace(/^@/, '')}`
      : null

  const wasAdmin = telegramChannelRegistry.getChannel(chatId)?.bot_is_admin === true
  telegramChannelRegistry.saveChannel({
    chatId,
    title,
    username,
    type: chatType,
    botIsAdmin: isAdmin,
  })

  if (isAdmin && !wasAdmin) {
    await postTelegramChannelAdminInvite(chatId)
    await notifyTelegramChannelJoined(chatId)
  }
}

export async function processTelegramMiniappBotUpdates(
  token: string,
  updates: Array<Record<string, unknown>>,
): Promise<void> {
  const mainToken = resolveTelegramBotToken()
  if (!mainToken || token.trim() !== mainToken) {
    return
  }
  await integrationsStore.load()

  for (const upd of updates) {
    if (upd.my_chat_member) {
      await handleTelegramMyChatMemberUpdate(upd)
    }
    const message = upd.message as Record<string, unknown> | undefined
    if (!message) {
      continue
    }
    const chat = message.chat as Record<string, unknown> | undefined
    const from = message.from as Record<string, unknown> | undefined
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    if (!chat || chat.type !== 'private' || !from || typeof from.id !== 'number') {
      continue
    }
    telegramBotUserStore.markStarted({
      id: from.id,
      username: typeof from.username === 'string' ? from.username : undefined,
      first_name: typeof from.first_name === 'string' ? from.first_name : undefined,
      last_name: typeof from.last_name === 'string' ? from.last_name : undefined,
    })
    if (!text.startsWith('/start')) {
      continue
    }
    const payload = text.replace(/^\/start\s*/i, '').trim()
    if (/^jointg\d+$/i.test(payload)) {
      await handleTelegramBotStartJoin(from.id, payload)
      continue
    }
    if (/^linkmax$/i.test(payload)) {
      const homeUrl = process.env.MINI_APP_URL?.trim() || 'https://t.me/commentvmax_bot'
      await sendTelegramBotMessage(
        token,
        from.id,
        '🔗 Связка с MAX\n\nОткройте мини-приложение CommentBot → «Создать связку» → выберите Telegram-канал и введите код из MAX.',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '💬 Открыть мини-приложение', url: homeUrl }]],
          },
        },
      )
    }
  }
}
