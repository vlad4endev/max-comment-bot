import axios from 'axios'

import { logger } from '../utils/logger'
import { telegramBotUserStore } from './telegramBotUserStore'
import type { IntegrationPlatform } from './integrationsStore'
import { flowStateStore } from './flowStateStore'

export interface PlatformTestResult {
  ok: boolean
  info?: string
  error?: string
}

export type TelegramChatType = 'channel' | 'group' | 'supergroup' | 'private' | 'unknown'

export interface PlatformChannelInfo {
  id: string
  title: string
  username?: string
  type?: TelegramChatType
  /** Бот — администратор (для каналов/групп). */
  botIsAdmin?: boolean
}

export interface TelegramChatAdminInfo {
  userId: number
  name: string
  username?: string
  isCreator: boolean
  startedBot: boolean
}

/** @deprecated используйте {@link listTelegramBotChats} */
export type TelegramLinkedChat = PlatformChannelInfo & {
  type: TelegramChatType
  botIsAdmin: boolean
}

const TG_API = 'https://api.telegram.org'

const TELEGRAM_DISCOVERY_UPDATES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'my_chat_member',
] as const

/** Webhook блокирует getUpdates — для опроса и обнаружения чатов нужен polling. */
export async function ensureTelegramPollingMode(token: string): Promise<void> {
  try {
    const { data } = await axios.get<{
      ok: boolean
      result?: { url?: string }
    }>(`${TG_API}/bot${token}/getWebhookInfo`, { timeout: 10_000 })
    const url = data.result?.url?.trim()
    if (!data.ok || !url) {
      return
    }
    await axios.get(`${TG_API}/bot${token}/deleteWebhook`, {
      params: { drop_pending_updates: false },
      timeout: 15_000,
    })
    logger.info('ensureTelegramPollingMode: webhook снят для getUpdates', { hadUrl: url })
  } catch (err: unknown) {
    logger.warn('ensureTelegramPollingMode failed', err)
  }
}

export function mergePlatformChannels(
  existing: PlatformChannelInfo[] | undefined,
  discovered: PlatformChannelInfo[],
): PlatformChannelInfo[] {
  const seen = new Map<string, PlatformChannelInfo>()
  for (const ch of existing ?? []) {
    seen.set(ch.id, { ...ch })
  }
  for (const ch of discovered) {
    const prev = seen.get(ch.id)
    if (!prev) {
      seen.set(ch.id, ch)
      continue
    }
    seen.set(ch.id, {
      id: ch.id,
      title: ch.title.length > prev.title.length ? ch.title : prev.title,
      username: ch.username ?? prev.username,
      type: ch.type && ch.type !== 'unknown' ? ch.type : prev.type,
      botIsAdmin: prev.botIsAdmin === true || ch.botIsAdmin === true,
    })
  }
  const typeOrder: Record<TelegramChatType, number> = {
    channel: 0,
    supergroup: 1,
    group: 2,
    private: 3,
    unknown: 4,
  }
  return [...seen.values()].sort((a, b) => {
    const adminDiff = Number(b.botIsAdmin === true) - Number(a.botIsAdmin === true)
    if (adminDiff !== 0) return adminDiff
    const typeDiff = (typeOrder[a.type ?? 'unknown'] ?? 9) - (typeOrder[b.type ?? 'unknown'] ?? 9)
    if (typeDiff !== 0) return typeDiff
    return a.title.localeCompare(b.title, 'ru')
  })
}

async function getTelegramBotUserId(token: string): Promise<number | null> {
  try {
    const { data } = await axios.get<{
      ok: boolean
      result?: { id?: number }
    }>(`${TG_API}/bot${token}/getMe`, { timeout: 15_000 })
    const id = data.result?.id
    return typeof id === 'number' ? id : null
  } catch {
    return null
  }
}

async function fetchTelegramChatMemberStatus(
  token: string,
  chatId: string,
  botUserId: number,
): Promise<{ botIsAdmin: boolean; title?: string; username?: string; type?: TelegramChatType }> {
  try {
    const { data } = await axios.get<{
      ok: boolean
      result?: { status?: string }
    }>(`${TG_API}/bot${token}/getChatMember`, {
      params: { chat_id: chatId, user_id: botUserId },
      timeout: 12_000,
    })
    const status = data.result?.status ?? ''
    const botIsAdmin = status === 'administrator' || status === 'creator'
    if (!data.ok) {
      return { botIsAdmin: false }
    }
    let chatMeta: { ok: boolean; result?: Record<string, unknown> } = { ok: false }
    try {
      const { data: chatData } = await axios.get<{
        ok: boolean
        result?: Record<string, unknown>
      }>(`${TG_API}/bot${token}/getChat`, {
        params: { chat_id: chatId },
        timeout: 12_000,
      })
      chatMeta = chatData
    } catch {
      chatMeta = { ok: false }
    }
    const chat = chatMeta.ok ? chatMeta.result : undefined
    return {
      botIsAdmin,
      title: chat ? chatTitleFromTelegramChat(chat, chatId) : undefined,
      username:
        typeof chat?.username === 'string' && chat.username.trim() !== ''
          ? `@${chat.username.replace(/^@/, '')}`
          : undefined,
      type: chat ? normalizeTelegramChatType(chat.type) : undefined,
    }
  } catch {
    return { botIsAdmin: false }
  }
}

/** Проверяет через getChatMember/getChat, где бот администратор (в т.ч. уже сохранённые чаты). */
export async function enrichTelegramChatsWithBotAdmin(
  token: string,
  chats: PlatformChannelInfo[],
): Promise<PlatformChannelInfo[]> {
  const trimmed = token.trim()
  if (trimmed === '' || chats.length === 0) {
    return chats
  }
  const botUserId = await getTelegramBotUserId(trimmed)
  if (botUserId === null) {
    return chats
  }

  const enriched: PlatformChannelInfo[] = []
  for (const ch of chats) {
    const member = await fetchTelegramChatMemberStatus(trimmed, ch.id, botUserId)
    enriched.push({
      id: ch.id,
      title: member.title && member.title.length > ch.title.length ? member.title : ch.title,
      username: member.username ?? ch.username,
      type: member.type && member.type !== 'unknown' ? member.type : ch.type,
      botIsAdmin: ch.botIsAdmin === true || member.botIsAdmin,
    })
  }
  return mergePlatformChannels(undefined, enriched)
}

export async function validateTelegramToken(token: string): Promise<PlatformTestResult> {
  try {
    const { data } = await axios.get<{ ok: boolean; result?: { username?: string; first_name?: string } }>(
      `${TG_API}/bot${token}/getMe`,
      { timeout: 15_000 },
    )
    if (!data.ok || !data.result) {
      return { ok: false, error: 'Telegram API вернул ошибку' }
    }
    const name = data.result.username ? `@${data.result.username}` : data.result.first_name ?? 'bot'
    return { ok: true, info: name }
  } catch (err: unknown) {
    logger.debug('validateTelegramToken failed', err)
    return { ok: false, error: 'Не удалось проверить токен Telegram' }
  }
}

export async function validateVkToken(
  token: string,
  groupId?: string,
): Promise<PlatformTestResult> {
  try {
    const params: Record<string, string | number> = {
      access_token: token,
      v: '5.199',
    }
    if (groupId && groupId.trim() !== '') {
      params.group_id = groupId.replace(/^-/, '').replace(/^public/, '')
    }
    const { data } = await axios.get<{
      response?: Array<{ name?: string; screen_name?: string }>
      error?: { error_msg?: string }
    }>('https://api.vk.com/method/groups.getById', { params, timeout: 15_000 })

    if (data.error) {
      return { ok: false, error: data.error.error_msg ?? 'VK API error' }
    }
    const g = data.response?.[0]
    if (!g && groupId) {
      const userCheck = await axios.get<{
        response?: Array<{ first_name?: string; last_name?: string }>
        error?: { error_msg?: string }
      }>('https://api.vk.com/method/users.get', {
        params: { access_token: token, v: '5.199' },
        timeout: 15_000,
      })
      if (userCheck.data.error) {
        return { ok: false, error: userCheck.data.error.error_msg ?? 'VK token invalid' }
      }
      const u = userCheck.data.response?.[0]
      return {
        ok: true,
        info: u ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() : 'VK token OK',
      }
    }
    return {
      ok: true,
      info: g ? g.name ?? g.screen_name ?? 'VK сообщество' : 'VK token OK',
    }
  } catch (err: unknown) {
    logger.debug('validateVkToken failed', err)
    return { ok: false, error: 'Не удалось проверить токен VK' }
  }
}

export async function testIntegration(
  platform: IntegrationPlatform,
  token: string,
  groupId?: string,
): Promise<PlatformTestResult> {
  if (platform === 'telegram') return validateTelegramToken(token)
  return validateVkToken(token, groupId)
}

function normalizeTelegramChatType(raw: unknown): TelegramChatType {
  if (raw === 'channel' || raw === 'group' || raw === 'supergroup' || raw === 'private') {
    return raw
  }
  return 'unknown'
}

function chatTitleFromTelegramChat(chat: Record<string, unknown>, fallbackId: string): string {
  if (typeof chat.title === 'string' && chat.title.trim() !== '') {
    return chat.title.trim()
  }
  const first = typeof chat.first_name === 'string' ? chat.first_name : ''
  const last = typeof chat.last_name === 'string' ? chat.last_name : ''
  const combined = `${first} ${last}`.trim()
  return combined !== '' ? combined : fallbackId
}

function mergeTelegramChat(
  seen: Map<string, PlatformChannelInfo>,
  chat: Record<string, unknown>,
  botIsAdmin: boolean,
): void {
  if (typeof chat.id !== 'number' && typeof chat.id !== 'string') {
    return
  }
  const id = String(chat.id)
  const type = normalizeTelegramChatType(chat.type)
  const username =
    typeof chat.username === 'string' && chat.username.trim() !== ''
      ? chat.username.startsWith('@')
        ? chat.username
        : `@${chat.username}`
      : undefined
  const title = chatTitleFromTelegramChat(chat, id)
  const existing = seen.get(id)
  if (!existing) {
    seen.set(id, { id, title, username, type, botIsAdmin })
    return
  }
  seen.set(id, {
    id,
    title: title.length > existing.title.length ? title : existing.title,
    username: username ?? existing.username,
    type: type !== 'unknown' ? type : existing.type,
    botIsAdmin: existing.botIsAdmin === true || botIsAdmin,
  })
}

function ingestTelegramUpdate(seen: Map<string, PlatformChannelInfo>, upd: Record<string, unknown>): void {
  const mcm = upd.my_chat_member as Record<string, unknown> | undefined
  if (mcm) {
    const chat = mcm.chat as Record<string, unknown> | undefined
    const member = mcm.new_chat_member as Record<string, unknown> | undefined
    const status = typeof member?.status === 'string' ? member.status : ''
    const isAdmin = status === 'administrator' || status === 'creator'
    const isMember = isAdmin || status === 'member'
    if (chat && isMember) {
      mergeTelegramChat(seen, chat, isAdmin)
    }
  }

  for (const key of ['channel_post', 'edited_channel_post', 'message', 'edited_message']) {
    const msg = upd[key] as Record<string, unknown> | undefined
    const chat = msg?.chat as Record<string, unknown> | undefined
    if (chat) {
      mergeTelegramChat(seen, chat, false)
    }
  }
}

function parseTelegramUserFromUnknown(raw: unknown): {
  id: number
  username?: string
  first_name?: string
  last_name?: string
} | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'number' ? o.id : Number.NaN
  if (!Number.isInteger(id) || id <= 0) {
    return null
  }
  return {
    id,
    username: typeof o.username === 'string' ? o.username : undefined,
    first_name: typeof o.first_name === 'string' ? o.first_name : undefined,
    last_name: typeof o.last_name === 'string' ? o.last_name : undefined,
  }
}

function rememberTelegramStartedUserFromUpdate(upd: Record<string, unknown>): void {
  const message = upd.message as Record<string, unknown> | undefined
  if (message) {
    const chat = message.chat as Record<string, unknown> | undefined
    const chatType = typeof chat?.type === 'string' ? chat.type : ''
    const fromUser = parseTelegramUserFromUnknown(message.from)
    if (chatType === 'private' && fromUser) {
      telegramBotUserStore.markStarted(fromUser)
    }
  }

  const callback = upd.callback_query as Record<string, unknown> | undefined
  if (callback) {
    const fromUser = parseTelegramUserFromUnknown(callback.from)
    if (fromUser) {
      telegramBotUserStore.markStarted(fromUser)
    }
  }
}

/** Чаты/каналы, с которыми бот взаимодействовал (из getUpdates + my_chat_member). */
export async function listTelegramBotChats(
  token: string,
  integrationId?: string,
): Promise<PlatformChannelInfo[]> {
  const trimmed = token.trim()
  if (trimmed === '') {
    return []
  }

  await ensureTelegramPollingMode(trimmed)

  const seen = new Map<string, PlatformChannelInfo>()
  await flowStateStore.load()
  let offset =
    integrationId !== undefined
      ? flowStateStore.getTelegramUpdateOffset(integrationId)
      : undefined

  try {
    for (let page = 0; page < 8; page++) {
      const params: Record<string, number | string> = {
        limit: 100,
        timeout: 0,
        allowed_updates: JSON.stringify(TELEGRAM_DISCOVERY_UPDATES),
      }
      if (offset !== undefined) {
        params.offset = offset
      }
      const { data } = await axios.get<{
        ok: boolean
        result?: Array<Record<string, unknown>>
      }>(`${TG_API}/bot${trimmed}/getUpdates`, { params, timeout: 20_000 })

      if (!data.ok || !data.result?.length) {
        break
      }

      for (const upd of data.result) {
        const updateId = typeof upd.update_id === 'number' ? upd.update_id : 0
        if (updateId >= (offset ?? 0)) {
          offset = updateId + 1
        }
        rememberTelegramStartedUserFromUpdate(upd)
        ingestTelegramUpdate(seen, upd)
      }

      if (data.result.length < 100) {
        break
      }
    }
    if (integrationId !== undefined && offset !== undefined) {
      await flowStateStore.setTelegramUpdateOffset(integrationId, offset)
    }
  } catch (err: unknown) {
    logger.warn('listTelegramBotChats: getUpdates failed', err)
  }

  const discovered = [...seen.values()]
  if (discovered.length === 0) {
    return []
  }
  return enrichTelegramChatsWithBotAdmin(trimmed, discovered)
}

export async function listTelegramAdminChannels(token: string): Promise<PlatformChannelInfo[]> {
  return listTelegramBotChats(token)
}

export async function listTelegramChatAdministrators(
  token: string,
  chatId: string,
): Promise<TelegramChatAdminInfo[]> {
  const trimmed = token.trim()
  if (trimmed === '') {
    return []
  }
  try {
    const { data } = await axios.get<{
      ok: boolean
      result?: Array<{
        status?: string
        user?: {
          id?: number
          username?: string
          first_name?: string
          last_name?: string
        }
      }>
    }>(`${TG_API}/bot${trimmed}/getChatAdministrators`, {
      params: { chat_id: chatId },
      timeout: 15_000,
    })
    if (!data.ok || !Array.isArray(data.result)) {
      return []
    }
    const rows: Array<{
      userId: number
      name: string
      username?: string
      isCreator: boolean
    }> = []
    for (const row of data.result) {
      const user = row.user
      const userId = typeof user?.id === 'number' ? user.id : null
      if (userId === null || !Number.isInteger(userId) || userId <= 0) {
        continue
      }
      const first = typeof user?.first_name === 'string' ? user.first_name.trim() : ''
      const last = typeof user?.last_name === 'string' ? user.last_name.trim() : ''
      const fullName = `${first} ${last}`.trim()
      const username = typeof user?.username === 'string' ? user.username.trim() : ''
      rows.push({
        userId,
        name: fullName || username || String(userId),
        username: username ? `@${username.replace(/^@/, '')}` : undefined,
        isCreator: row.status === 'creator',
      })
    }
    const started = telegramBotUserStore.getStartedIds(rows.map((r) => r.userId))
    return rows
      .map((row) => ({
        ...row,
        startedBot: started.has(row.userId),
      }))
      .sort((a, b) => {
        const creatorDiff = Number(b.isCreator) - Number(a.isCreator)
        if (creatorDiff !== 0) return creatorDiff
        const startedDiff = Number(b.startedBot) - Number(a.startedBot)
        if (startedDiff !== 0) return startedDiff
        return a.name.localeCompare(b.name, 'ru')
      })
  } catch {
    return []
  }
}

export async function listVkGroups(token: string, groupId?: string): Promise<PlatformChannelInfo[]> {
  if (!groupId || groupId.trim() === '') {
    return []
  }
  try {
    const { data } = await axios.get<{
      response?: Array<{ id: number; name?: string; screen_name?: string }>
      error?: { error_msg?: string }
    }>('https://api.vk.com/method/groups.getById', {
      params: {
        access_token: token,
        group_id: groupId.replace(/^-/, '').replace(/^public/, ''),
        v: '5.199',
      },
      timeout: 15_000,
    })
    if (data.error || !data.response?.length) return []
    return data.response.map((g) => ({
      id: String(-g.id),
      title: g.name ?? String(g.id),
      username: g.screen_name ? g.screen_name : undefined,
    }))
  } catch (err: unknown) {
    logger.debug('listVkGroups failed', err)
    return []
  }
}

export interface ExternalPost {
  externalId: string
  text: string
  hasMedia: boolean
  createdAt?: number
}

function mapTelegramChannelPost(msg: Record<string, unknown>): ExternalPost {
  const messageId = typeof msg.message_id === 'number' ? msg.message_id : 0
  const text =
    typeof msg.text === 'string'
      ? msg.text
      : typeof msg.caption === 'string'
        ? msg.caption
        : ''
  const hasMedia = Array.isArray(msg.photo) || msg.video != null || msg.document != null
  return {
    externalId: String(messageId),
    text,
    hasMedia,
    createdAt: typeof msg.date === 'number' ? msg.date * 1000 : undefined,
  }
}

function channelPostMatchesTarget(
  chat: Record<string, unknown>,
  channelId: string,
): boolean {
  const targetId = channelId.replace(/^@/, '')
  const chatKey =
    typeof chat.username === 'string' ? chat.username.toLowerCase() : String(chat.id)
  return targetId.startsWith('-') || /^\d+$/.test(targetId)
    ? String(chat.id) === targetId
    : chatKey === targetId.toLowerCase().replace(/^@/, '')
}

function extractTelegramMessageFromUpdate(
  upd: Record<string, unknown>,
): Record<string, unknown> | undefined {
  for (const key of ['channel_post', 'edited_channel_post', 'message', 'edited_message']) {
    const msg = upd[key] as Record<string, unknown> | undefined
    if (msg) return msg
  }
  return undefined
}

function isTelegramServiceMessage(msg: Record<string, unknown>): boolean {
  return (
    msg.new_chat_members != null ||
    msg.left_chat_member != null ||
    msg.new_chat_title != null ||
    msg.pinned_message != null ||
    msg.group_chat_created != null ||
    msg.supergroup_chat_created != null ||
    msg.channel_chat_created != null
  )
}

const telegramFetchLocks = new Map<string, Promise<void>>()

async function withTelegramIntegrationLock<T>(
  integrationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = telegramFetchLocks.get(integrationId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  telegramFetchLocks.set(
    integrationId,
    prev.then(() => gate),
  )
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (telegramFetchLocks.get(integrationId) === gate) {
      telegramFetchLocks.delete(integrationId)
    }
  }
}

async function warnIfTelegramWebhookActive(token: string): Promise<void> {
  try {
    const { data } = await axios.get<{
      ok: boolean
      result?: { url?: string }
    }>(`${TG_API}/bot${token}/getWebhookInfo`, { timeout: 10_000 })
    const url = data.result?.url
    if (data.ok && url && url.trim() !== '') {
      logger.error(
        'fetchTelegramChannelPosts: у бота включён webhook — getUpdates пустой. Удалите webhook: deleteWebhook',
        { webhookUrl: url },
      )
    }
  } catch {
    /* ignore */
  }
}

async function probeTelegramChannelAccess(token: string, channelId: string): Promise<void> {
  try {
    const { data } = await axios.get<{
      ok: boolean
      result?: { title?: string; type?: string }
    }>(`${TG_API}/bot${token}/getChat`, {
      params: { chat_id: channelId },
      timeout: 15_000,
    })
    if (data.ok && data.result) {
      logger.info('fetchTelegramChannelPosts: chat accessible via getChat', {
        channelId,
        title: data.result.title,
        type: data.result.type,
      })
    }
  } catch (err: unknown) {
    const axErr = axios.isAxiosError(err) ? err : null
    logger.error('fetchTelegramChannelPosts: chat not accessible', {
      channelId,
      error: axErr?.response?.data,
    })
  }
}

/**
 * Новые посты/сообщения из TG-канала, группы или супергруппы через getUpdates.
 * Каналы: channel_post; группы/чаты: message.
 *
 * Попутно собирает my_chat_member-события, где бот становится администратором,
 * и возвращает их в {@link discoveredChats} для немедленного обновления linkedChats.
 * Это необходимо, потому что оба механизма (опрос постов и обнаружение каналов)
 * используют один и тот же getUpdates offset — без такой инлайн-обработки
 * my_chat_member-события будут «съедены» поллером постов до того, как
 * listTelegramBotChats получит шанс их увидеть.
 */
export async function fetchTelegramChannelPosts(
  token: string,
  integrationId: string,
  channelId: string,
  afterMessageId: number,
): Promise<{ posts: ExternalPost[]; lastMessageId: number; discoveredChats: PlatformChannelInfo[] }> {
  return withTelegramIntegrationLock(integrationId, async () => {
    await flowStateStore.load()
    await ensureTelegramPollingMode(token.trim())
    try {
      const storedOffset = flowStateStore.getTelegramUpdateOffset(integrationId)
      const params: Record<string, string | number> = {
        limit: 100,
        timeout: 0,
      }
      if (storedOffset !== undefined) {
        params.offset = storedOffset
      }

      const { data } = await axios.get<{
        ok: boolean
        result?: Array<Record<string, unknown>>
      }>(`${TG_API}/bot${token}/getUpdates`, { params, timeout: 20_000 })

      if (!data.ok || !data.result?.length) {
        if (storedOffset === undefined) {
          await warnIfTelegramWebhookActive(token)
        }
        return { posts: [], lastMessageId: afterMessageId, discoveredChats: [] }
      }

      const posts: ExternalPost[] = []
      const newAdminChats = new Map<string, PlatformChannelInfo>()
      let maxMessageId = afterMessageId
      let maxUpdateId = storedOffset ?? 0
      let matchedInBatch = 0
      let seenForTarget = 0

      for (const upd of data.result) {
        const updateId = typeof upd.update_id === 'number' ? upd.update_id : 0
        if (updateId >= maxUpdateId) {
          maxUpdateId = updateId + 1
        }
        rememberTelegramStartedUserFromUpdate(upd)

        // Capture bot becoming admin in a channel/group so the caller can update linkedChats
        // immediately — without this, the event would be consumed by this loop and lost
        // before listTelegramBotChats ever gets a chance to see it.
        const mcm = upd.my_chat_member as Record<string, unknown> | undefined
        if (mcm) {
          const mcmChat = mcm.chat as Record<string, unknown> | undefined
          const newMember = mcm.new_chat_member as Record<string, unknown> | undefined
          const status = typeof newMember?.status === 'string' ? newMember.status : ''
          if ((status === 'administrator' || status === 'creator') && mcmChat) {
            mergeTelegramChat(newAdminChats, mcmChat, true)
          }
        }

        const msg = extractTelegramMessageFromUpdate(upd)
        if (!msg || isTelegramServiceMessage(msg)) continue

        const from = msg.from as Record<string, unknown> | undefined
        if (from?.is_bot === true) continue

        const chat = msg.chat as Record<string, unknown> | undefined
        if (!chat || !channelPostMatchesTarget(chat, channelId)) continue

        seenForTarget += 1
        const messageId = typeof msg.message_id === 'number' ? msg.message_id : 0
        if (messageId > maxMessageId) {
          maxMessageId = messageId
        }
        if (messageId <= afterMessageId) continue

        matchedInBatch += 1
        posts.push(mapTelegramChannelPost(msg))
      }

      if (maxUpdateId > (storedOffset ?? 0)) {
        await flowStateStore.setTelegramUpdateOffset(integrationId, maxUpdateId)
      }

      const discoveredChats = [...newAdminChats.values()]

      logger.info('fetchTelegramChannelPosts: batch', {
        channelId,
        updates: data.result.length,
        seenForTarget,
        newPosts: posts.length,
        afterMessageId,
        lastMessageId: maxMessageId,
        newAdminChats: discoveredChats.length,
      })

      if (posts.length === 0 && afterMessageId > 0 && seenForTarget === 0) {
        await probeTelegramChannelAccess(token, channelId)
      }

      return { posts, lastMessageId: maxMessageId, discoveredChats }
    } catch (err: unknown) {
      logger.warn('fetchTelegramChannelPosts failed', err)
      return { posts: [], lastMessageId: afterMessageId, discoveredChats: [] }
    }
  })
}

export async function fetchVkWallPosts(
  token: string,
  groupId: string,
  afterPostId: number,
): Promise<{ posts: ExternalPost[]; lastPostId: number }> {
  const ownerId = groupId.startsWith('-') ? groupId : `-${groupId.replace(/^public/, '')}`
  try {
    const { data } = await axios.get<{
      response?: { items?: Array<Record<string, unknown>> }
      error?: { error_msg?: string }
    }>('https://api.vk.com/method/wall.get', {
      params: {
        access_token: token,
        owner_id: ownerId,
        count: 20,
        filter: 'owner',
        v: '5.199',
      },
      timeout: 15_000,
    })
    if (data.error || !data.response?.items) {
      return { posts: [], lastPostId: afterPostId }
    }

    const posts: ExternalPost[] = []
    let maxId = afterPostId
    for (const item of data.response.items) {
      const id = typeof item.id === 'number' ? item.id : 0
      if (id > maxId) maxId = id
      if (id <= afterPostId) continue
      const text = typeof item.text === 'string' ? item.text : ''
      const attachments = item.attachments
      const hasMedia = Array.isArray(attachments) && attachments.length > 0
      posts.push({
        externalId: String(id),
        text,
        hasMedia,
        createdAt: typeof item.date === 'number' ? item.date * 1000 : undefined,
      })
    }
    return { posts, lastPostId: maxId }
  } catch (err: unknown) {
    logger.warn('fetchVkWallPosts failed', err)
    return { posts: [], lastPostId: afterPostId }
  }
}

export async function publishVkWallPost(
  token: string,
  groupId: string,
  message: string,
): Promise<void> {
  const ownerId = groupId.startsWith('-') ? groupId : `-${groupId.replace(/^public/, '')}`
  const { data } = await axios.get<{ error?: { error_msg?: string } }>(
    'https://api.vk.com/method/wall.post',
    {
      params: {
        access_token: token,
        owner_id: ownerId,
        from_group: 1,
        message,
        v: '5.199',
      },
      timeout: 15_000,
    },
  )
  if (data.error) {
    throw new Error(data.error.error_msg ?? 'VK wall.post failed')
  }
}
