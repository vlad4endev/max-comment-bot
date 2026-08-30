import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios'
import FormData from 'form-data'

import { ensureAdminPanelStateLoaded, listTgChainsSync } from '../api/adminPanelState'
import { logger } from '../utils/logger'
import { telegramAxios } from '../utils/telegramAxios'
import { isTelegramUnauthorizedError } from '../utils/telegramSyncErrors'
import { telegramBotUserStore } from './telegramBotUserStore'
import { processMainTelegramBotMyChatMemberUpdate } from './telegramMainBotUpdates'
import type { IntegrationPlatform } from './integrationsStore'
import { isMainTelegramBotToken } from './resolveTelegramBotToken'
import { flowStateStore } from './flowStateStore'
import {
  getTelegramBotUpdatesOffset,
  setTelegramBotUpdatesOffset,
} from './telegramMainBotOffsetStore'
import { normalizeTelegramChannelKey } from '../utils/tgChannelMatch'
import { telegramChannelRegistry } from './telegramChannelRegistry'
import { isTelegramGetUpdatesOwnedByForwarder } from './telegramGetUpdatesOwner'

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

async function httpGet<T>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
  if (url.startsWith(TG_API)) {
    return telegramAxios.get<T>(url, config)
  }
  return axios.get<T>(url, config)
}

const TELEGRAM_DISCOVERY_UPDATES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'my_chat_member',
] as const

const TELEGRAM_DISCOVERY_MAX_PAGES = 16

function isNumericTelegramChatId(raw: string): boolean {
  return /^-?\d+$/.test(String(raw).trim())
}

function persistTelegramChannelsToRegistry(channels: PlatformChannelInfo[]): void {
  for (const ch of channels) {
    if (ch.type !== 'channel' && ch.type !== 'supergroup' && ch.type !== 'group') {
      continue
    }
    telegramChannelRegistry.saveChannel({
      chatId: ch.id,
      title: ch.title,
      username: ch.username,
      type: ch.type ?? 'channel',
      botIsAdmin: ch.botIsAdmin === true,
    })
  }
}

/** ID из реестра, кэша интеграции и TG→MAX связок — для проверки прав бота через getChatMember. */
async function buildTelegramLinkedChatCandidateStubs(
  token: string,
  options: {
    existingLinkedChats?: PlatformChannelInfo[]
    resolveUsernames: boolean
  },
): Promise<PlatformChannelInfo[]> {
  await ensureAdminPanelStateLoaded()
  const ids = new Set<string>()

  for (const row of telegramChannelRegistry.getAllChannels()) {
    ids.add(row.chat_id)
  }
  for (const ch of options.existingLinkedChats ?? []) {
    const id = String(ch.id ?? '').trim()
    if (isNumericTelegramChatId(id)) {
      ids.add(id)
    }
  }
  for (const chain of listTgChainsSync()) {
    const channelId = chain.tg_channel_id?.trim() ?? ''
    if (isNumericTelegramChatId(channelId)) {
      ids.add(channelId)
    }
    const discussionId = chain.tg_discussion_chat_id?.trim() ?? ''
    if (isNumericTelegramChatId(discussionId)) {
      ids.add(discussionId)
    }
    if (options.resolveUsernames) {
      const uname = chain.tg_username?.trim().replace(/^@/, '') ?? ''
      if (uname && !isNumericTelegramChatId(channelId)) {
        const resolved = await resolveTelegramChannelChatIdFromKey(token, `@${uname}`)
        if (resolved && isNumericTelegramChatId(resolved.chatId)) {
          ids.add(resolved.chatId)
        }
      }
    }
  }

  return [...ids].map((id) => {
    const reg = telegramChannelRegistry.getChannel(id)
    const rawType = reg?.type?.trim() ?? 'channel'
    const type: TelegramChatType =
      rawType === 'channel' ||
      rawType === 'supergroup' ||
      rawType === 'group' ||
      rawType === 'private'
        ? rawType
        : 'channel'
    const username =
      reg?.username && reg.username.trim() !== ''
        ? reg.username.startsWith('@')
          ? reg.username
          : `@${reg.username.replace(/^@/, '')}`
        : undefined
    return {
      id,
      title: reg?.title?.trim() || id,
      username,
      type,
      botIsAdmin: reg?.bot_is_admin,
    }
  })
}

async function finalizeTelegramLinkedChatsList(options: {
  token: string
  existingLinkedChats?: PlatformChannelInfo[]
  discovered: PlatformChannelInfo[]
  refresh: boolean
}): Promise<PlatformChannelInfo[]> {
  const trimmed = options.token.trim()
  const registryChannels = listTelegramChannelsFromRegistry()
  const candidateStubs = await buildTelegramLinkedChatCandidateStubs(trimmed, {
    existingLinkedChats: options.existingLinkedChats,
    resolveUsernames: options.refresh,
  })

  let channels = mergePlatformChannels(
    mergePlatformChannels(options.existingLinkedChats, options.discovered),
    mergePlatformChannels(registryChannels, candidateStubs),
  )
  if (trimmed !== '') {
    channels = await enrichTelegramChatsWithBotAdmin(trimmed, channels)
    if (options.refresh) {
      persistTelegramChannelsToRegistry(channels)
    }
  }
  return channels
}

/** Webhook блокирует getUpdates — для опроса и обнаружения чатов нужен polling. */
export async function ensureTelegramPollingMode(token: string): Promise<void> {
  try {
    const { data } = await httpGet<{
      ok: boolean
      result?: { url?: string }
    }>(`${TG_API}/bot${token}/getWebhookInfo`, { timeout: 10_000 })
    const url = data.result?.url?.trim()
    if (!data.ok || !url) {
      return
    }
    await httpGet(`${TG_API}/bot${token}/deleteWebhook`, {
      params: { drop_pending_updates: false },
      timeout: 15_000,
    })
    logger.info('ensureTelegramPollingMode: webhook снят для getUpdates', { hadUrl: url })
  } catch (err: unknown) {
    logger.warn('ensureTelegramPollingMode failed', err)
  }
}

/** Каналы из SQLite (my_chat_member / активация), которые могут отсутствовать в getUpdates. */
export function listTelegramChannelsFromRegistry(): PlatformChannelInfo[] {
  return telegramChannelRegistry.getAllChannels().map((row) => {
    const rawType = row.type?.trim() ?? 'channel'
    const type: TelegramChatType =
      rawType === 'channel' ||
      rawType === 'supergroup' ||
      rawType === 'group' ||
      rawType === 'private'
        ? rawType
        : 'channel'
    const username =
      row.username && row.username.trim() !== ''
        ? row.username.startsWith('@')
          ? row.username
          : `@${row.username.replace(/^@/, '')}`
        : undefined
    return {
      id: row.chat_id,
      title: row.title?.trim() || row.chat_id,
      username,
      type,
      botIsAdmin: row.bot_is_admin,
    }
  })
}

export function telegramLinkedChatsSnapshotChanged(
  before: PlatformChannelInfo[] | undefined,
  after: PlatformChannelInfo[],
): boolean {
  const prev = before ?? []
  if (prev.length !== after.length) {
    return true
  }
  const nextById = new Map(after.map((c) => [c.id, c]))
  for (const ch of prev) {
    const n = nextById.get(ch.id)
    if (!n) {
      return true
    }
    if ((ch.botIsAdmin === true) !== (n.botIsAdmin === true)) {
      return true
    }
    if (ch.title !== n.title || ch.username !== n.username) {
      return true
    }
  }
  return false
}

async function syncTelegramDiscoveryBeforeList(token: string): Promise<void> {
  if (!isMainTelegramBotToken(token)) {
    return
  }
  try {
    const { syncMainTelegramBotDiscoveryUpdates } = await import('./tgChainForwarder')
    await syncMainTelegramBotDiscoveryUpdates(token, {
      timeoutSec: 0,
      maxPages: TELEGRAM_DISCOVERY_MAX_PAGES,
    })
  } catch (err: unknown) {
    logger.warn('syncTelegramDiscoveryBeforeList failed', err)
  }
}

/** Список чатов для интеграции: кэш, getUpdates и реестр tg_channels. */
export async function buildTelegramLinkedChatsList(options: {
  integrationId: string
  token: string
  existingLinkedChats?: PlatformChannelInfo[]
  refresh: boolean
}): Promise<PlatformChannelInfo[]> {
  const { integrationId, token, existingLinkedChats, refresh } = options
  const trimmed = token.trim()

  if (!refresh && (existingLinkedChats?.length ?? 0) > 0) {
    return finalizeTelegramLinkedChatsList({
      token: trimmed,
      existingLinkedChats,
      discovered: [],
      refresh: false,
    })
  }

  if (refresh && trimmed !== '') {
    await syncTelegramDiscoveryBeforeList(trimmed)
  }

  const discovered =
    trimmed !== '' ? await listTelegramBotChats(trimmed, integrationId) : []
  return finalizeTelegramLinkedChatsList({
    token: trimmed,
    existingLinkedChats,
    discovered,
    refresh,
  })
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

export async function getTelegramBotUserId(token: string): Promise<number | null> {
  try {
    const { data } = await httpGet<{
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
    const { data } = await httpGet<{
      ok: boolean
      result?: { status?: string }
    }>(`${TG_API}/bot${token}/getChatMember`, {
      params: { chat_id: chatId, user_id: botUserId },
      timeout: 12_000,
    })
    const status = data.result?.status ?? ''
    const botIsAdmin = status === 'administrator' || status === 'creator'
    if (!data.ok) {
      logger.debug('fetchTelegramChatMemberStatus: getChatMember not ok', { chatId })
      return { botIsAdmin: false }
    }
    let chatMeta: { ok: boolean; result?: Record<string, unknown> } = { ok: false }
    try {
      const { data: chatData } = await httpGet<{
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
  } catch (err: unknown) {
    logger.debug('fetchTelegramChatMemberStatus failed', { chatId, err })
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
    const { data } = await httpGet<{
      ok: boolean
      description?: string
      result?: { username?: string; first_name?: string }
    }>(
      `${TG_API}/bot${token}/getMe`,
      { timeout: 15_000 },
    )
    if (!data.ok || !data.result) {
      const description = data.description ?? ''
      if (isTelegramUnauthorizedError(description)) {
        return { ok: false, error: 'Токен Telegram недействителен (401 Unauthorized)' }
      }
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
    const { data } = await httpGet<{
      response?: Array<{ name?: string; screen_name?: string }>
      error?: { error_msg?: string }
    }>('https://api.vk.com/method/groups.getById', { params, timeout: 15_000 })

    if (data.error) {
      return { ok: false, error: data.error.error_msg ?? 'VK API error' }
    }
    const g = data.response?.[0]
    if (!g && groupId) {
      const userCheck = await httpGet<{
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

/** Разрешает @username / t.me/… / -100… в числовой chat_id через getChat. */
export async function resolveTelegramChannelChatIdFromKey(
  token: string,
  channelKeyRaw: string,
): Promise<{
  chatId: string
  title: string | null
  username: string | null
  type: TelegramChatType
} | null> {
  const trimmed = channelKeyRaw.trim()
  if (!trimmed) {
    return null
  }
  let lookup = trimmed
  const tmeMatch = /(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]+)/i.exec(trimmed)
  if (tmeMatch) {
    lookup = `@${tmeMatch[1]}`
  } else if (/^t\.me\//i.test(trimmed)) {
    lookup = `@${trimmed.replace(/^t\.me\//i, '')}`
  } else if (!lookup.startsWith('@') && !/^-?\d+$/.test(lookup)) {
    lookup = `@${lookup.replace(/^@/, '')}`
  }

  const tgToken = token.trim()
  if (!tgToken) {
    return null
  }

  try {
    const { data } = await httpGet<{
      ok: boolean
      result?: Record<string, unknown>
    }>(`${TG_API}/bot${tgToken}/getChat`, {
      params: { chat_id: /^-?\d+$/.test(lookup) ? lookup : normalizeTelegramChannelKey(lookup) },
      timeout: 15_000,
    })
    if (!data.ok || !data.result) {
      return null
    }
    const chat = data.result
    const id =
      typeof chat.id === 'number' || typeof chat.id === 'string' ? String(chat.id) : null
    if (!id || !/^-?\d+$/.test(id)) {
      return null
    }
    const chatType = normalizeTelegramChatType(chat.type)
    const username =
      typeof chat.username === 'string' && chat.username.trim() !== ''
        ? `@${chat.username.replace(/^@/, '')}`
        : null
    return {
      chatId: id,
      title: chatTitleFromTelegramChat(chat, id),
      username,
      type: chatType,
    }
  } catch (err: unknown) {
    logger.warn('resolveTelegramChannelChatIdFromKey: getChat failed', { lookup, err })
    return null
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

  if (isMainTelegramBotToken(trimmed) && isTelegramGetUpdatesOwnedByForwarder(trimmed)) {
    return enrichTelegramChatsWithBotAdmin(trimmed, listTelegramChannelsFromRegistry())
  }

  const seen = new Map<string, PlatformChannelInfo>()
  await flowStateStore.load()
  const useMainBotOffset = isMainTelegramBotToken(trimmed)
  let offset: number | undefined = useMainBotOffset
    ? getTelegramBotUpdatesOffset(trimmed)
    : integrationId !== undefined
      ? flowStateStore.getTelegramUpdateOffset(integrationId)
      : undefined

  try {
    for (let page = 0; page < TELEGRAM_DISCOVERY_MAX_PAGES; page++) {
      const params: Record<string, number | string> = {
        limit: 100,
        timeout: 0,
        allowed_updates: JSON.stringify(TELEGRAM_DISCOVERY_UPDATES),
      }
      if (offset !== undefined) {
        params.offset = offset
      }
      const { data } = await httpGet<{
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
        await processMainTelegramBotMyChatMemberUpdate(trimmed, upd)
        ingestTelegramUpdate(seen, upd)
      }

      if (data.result.length < 100) {
        break
      }
    }
    if (offset !== undefined) {
      if (useMainBotOffset) {
        setTelegramBotUpdatesOffset(trimmed, offset)
      } else if (integrationId !== undefined) {
        await flowStateStore.setTelegramUpdateOffset(integrationId, offset)
      }
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
    const { data } = await httpGet<{
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

export interface VkGroupInfo {
  /** Числовой ID без минуса */
  id: string
  name: string
  screenName: string
  /** Правильная ссылка vk.com/{screenName} */
  url: string
  photo?: string
}

export interface VkGroupResolveResult {
  group: VkGroupInfo | null
  error?: string
}

interface VkGroupApiItem {
  id: number
  name?: string
  screen_name?: string
  photo_50?: string
  photo_100?: string
}

/** Нормализует ввод: URL, club123, public123, clubslug → slug/id для VK API. */
function normalizeVkGroupLookup(input: string): string {
  const raw = input.trim()
  if (!raw) return ''

  const urlMatch = /(?:https?:\/\/)?(?:www\.|m\.)?vk\.com\/([a-zA-Z0-9_.-]+)/i.exec(raw)
  let lookup = urlMatch ? urlMatch[1]! : raw
  lookup = lookup.replace(/^@/, '').replace(/^-/, '')

  const prefixedNumeric = /^(?:club|public|event)(\d+)$/i.exec(lookup)
  if (prefixedNumeric) return prefixedNumeric[1]!

  // vk.com/clubostrovskidok → ostrovskidok (лишний префикс club перед буквами)
  if (/^club[a-zA-Z_]/i.test(lookup)) return lookup.slice(4)
  if (/^public[a-zA-Z_]/i.test(lookup)) return lookup.slice(6)

  return lookup
}

/** VK API 5.139+: response — объект { groups, profiles }; раньше — массив. */
function parseVkGroupsGetByIdItems(response: unknown): VkGroupApiItem[] {
  if (!response) return []
  if (Array.isArray(response)) return response as VkGroupApiItem[]
  if (typeof response === 'object' && response !== null) {
    const groups = (response as { groups?: unknown }).groups
    if (Array.isArray(groups)) return groups as VkGroupApiItem[]
  }
  return []
}

function mapVkGroupApiItem(g: VkGroupApiItem): VkGroupInfo {
  const screenName = g.screen_name?.trim() || `club${g.id}`
  return {
    id: String(g.id),
    name: g.name?.trim() || screenName,
    screenName,
    url: `https://vk.com/${screenName}`,
    photo: g.photo_100 ?? g.photo_50,
  }
}

async function fetchVkGroupByLookup(
  token: string,
  lookup: string,
): Promise<VkGroupResolveResult> {
  if (!lookup) {
    return { group: null, error: 'Пустой ввод' }
  }

  try {
    const { data } = await httpGet<{
      response?: unknown
      error?: { error_code?: number; error_msg?: string }
    }>('https://api.vk.com/method/groups.getById', {
      params: {
        access_token: token,
        group_id: lookup,
        fields: 'screen_name,photo_50,photo_100',
        v: '5.199',
      },
      timeout: 15_000,
    })

    if (data.error) {
      const msg = data.error.error_msg?.trim() || 'Ошибка VK API'
      logger.debug('fetchVkGroupByLookup vk error', { lookup, error: data.error })
      return { group: null, error: msg }
    }

    const items = parseVkGroupsGetByIdItems(data.response)
    if (!items.length) {
      return { group: null, error: 'Сообщество не найдено. Проверьте ссылку или ID.' }
    }

    return { group: mapVkGroupApiItem(items[0]!) }
  } catch (err: unknown) {
    logger.debug('fetchVkGroupByLookup failed', { lookup, err })
    return { group: null, error: 'Не удалось связаться с VK API' }
  }
}

export async function listVkGroups(token: string, groupId?: string): Promise<PlatformChannelInfo[]> {
  if (!groupId || groupId.trim() === '') {
    return []
  }
  const lookup = normalizeVkGroupLookup(groupId)
  const result = await fetchVkGroupByLookup(token, lookup)
  if (!result.group) return []
  const g = result.group
  return [{
    id: String(-Number(g.id)),
    title: g.name,
    username: g.screenName !== `club${g.id}` ? g.screenName : undefined,
  }]
}

/**
 * Разрешает VK-сообщество из любого формата ввода:
 * числовой ID, -ID, URL (vk.com/...), slug (ostrovskidok).
 */
export async function resolveVkGroup(
  token: string,
  input: string,
): Promise<VkGroupResolveResult> {
  const lookup = normalizeVkGroupLookup(input)
  return fetchVkGroupByLookup(token, lookup)
}

/**
 * Список сообществ, где токен имеет права администратора/редактора.
 */
export async function listVkManagedGroups(token: string): Promise<VkGroupInfo[]> {
  try {
    const { data } = await httpGet<{
      response?: {
        count?: number
        items?: Array<{
          id: number
          name?: string
          screen_name?: string
          photo_50?: string
          photo_100?: string
        }>
      }
      error?: { error_msg?: string }
    }>('https://api.vk.com/method/groups.get', {
      params: {
        access_token: token,
        filter: 'moder',
        fields: 'screen_name,photo_50,photo_100',
        count: 100,
        v: '5.199',
      },
      timeout: 15_000,
    })
    if (data.error || !data.response?.items) return []
    return data.response.items.map((g) => {
      const screenName = g.screen_name ?? `club${g.id}`
      return {
        id: String(g.id),
        name: g.name?.trim() || `club${g.id}`,
        screenName,
        url: `https://vk.com/${screenName}`,
        photo: g.photo_100 ?? g.photo_50,
      }
    })
  } catch (err: unknown) {
    logger.debug('listVkManagedGroups failed', err)
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
    const { data } = await httpGet<{
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
    const { data } = await httpGet<{
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
    const trimmedToken = token.trim()
    await ensureTelegramPollingMode(trimmedToken)
    const useMainBotOffset = isMainTelegramBotToken(trimmedToken)
    if (useMainBotOffset && isTelegramGetUpdatesOwnedByForwarder(trimmedToken)) {
      return { posts: [], lastMessageId: afterMessageId, discoveredChats: [] }
    }
    const readOffset = useMainBotOffset
      ? getTelegramBotUpdatesOffset(trimmedToken)
      : flowStateStore.getTelegramUpdateOffset(integrationId)
    try {
      const params: Record<string, string | number> = {
        limit: 100,
        timeout: 0,
      }
      if (readOffset !== undefined) {
        params.offset = readOffset
      }

      const { data } = await httpGet<{
        ok: boolean
        result?: Array<Record<string, unknown>>
      }>(`${TG_API}/bot${trimmedToken}/getUpdates`, { params, timeout: 20_000 })

      if (!data.ok || !data.result?.length) {
        if (readOffset === undefined) {
          await warnIfTelegramWebhookActive(token)
        }
        return { posts: [], lastMessageId: afterMessageId, discoveredChats: [] }
      }

      const posts: ExternalPost[] = []
      const newAdminChats = new Map<string, PlatformChannelInfo>()
      let maxMessageId = afterMessageId
      let maxUpdateId = readOffset ?? 0
      let matchedInBatch = 0
      let seenForTarget = 0

      for (const upd of data.result) {
        const updateId = typeof upd.update_id === 'number' ? upd.update_id : 0
        if (updateId >= maxUpdateId) {
          maxUpdateId = updateId + 1
        }
        rememberTelegramStartedUserFromUpdate(upd)
        await processMainTelegramBotMyChatMemberUpdate(trimmedToken, upd)

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

      const offsetBefore = readOffset ?? 0
      if (maxUpdateId > offsetBefore) {
        if (useMainBotOffset) {
          setTelegramBotUpdatesOffset(trimmedToken, maxUpdateId)
        } else {
          await flowStateStore.setTelegramUpdateOffset(integrationId, maxUpdateId)
        }
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
        offsetStore: useMainBotOffset ? 'tg_chain_reader_offsets' : 'flow-state.json',
      })

      if (posts.length === 0 && afterMessageId > 0 && seenForTarget === 0) {
        await probeTelegramChannelAccess(token, channelId)
      }

      return { posts, lastMessageId: maxMessageId, discoveredChats }
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        logger.warn(
          'fetchTelegramChannelPosts: 409 conflict — другой процесс уже опрашивает getUpdates (tgChainForwarder?)',
          { integrationId, channelId },
        )
      } else {
        logger.warn('fetchTelegramChannelPosts failed', err)
      }
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
    const { data } = await httpGet<{
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

function vkPositiveGroupId(groupId: string): string {
  return groupId.replace(/^public/i, '').replace(/^-/, '')
}

type VkApiErrorBody = {
  error_code?: number
  error_msg?: string
}

function formatVkApiError(method: string, error: VkApiErrorBody | undefined): string {
  const code = error?.error_code != null ? ` [${error.error_code}]` : ''
  const msg = error?.error_msg ?? `VK ${method} failed`
  return `${msg}${code}`
}

async function vkApiCall<T>(
  method: string,
  token: string,
  params: Record<string, string | number>,
  options?: { usePost?: boolean },
): Promise<T> {
  const payload = { ...params, access_token: token, v: '5.199' }
  const url = `https://api.vk.com/method/${method}`
  const { data } = options?.usePost
    ? await axios.post<{ response?: T; error?: VkApiErrorBody }>(url, new URLSearchParams(
        Object.entries(payload).map(([k, v]) => [k, String(v)]),
      ).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 60_000,
      })
    : await httpGet<{ response?: T; error?: VkApiErrorBody }>(url, {
        params: payload,
        timeout: 60_000,
      })
  if (data.error) {
    throw new Error(formatVkApiError(method, data.error))
  }
  if (data.response === undefined) {
    throw new Error(`VK ${method}: empty response`)
  }
  return data.response
}

function detectVkImageMeta(buffer: Buffer, filenameHint?: string): { filename: string; contentType: string } {
  const hintName = filenameHint?.trim() || ''
  const hint = hintName.toLowerCase()
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return {
      filename: hint.endsWith('.jpg') || hint.endsWith('.jpeg') ? hintName : 'photo.jpg',
      contentType: 'image/jpeg',
    }
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return { filename: hint.endsWith('.png') ? hintName : 'photo.png', contentType: 'image/png' }
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { filename: hint.endsWith('.webp') ? hintName : 'photo.webp', contentType: 'image/webp' }
  }
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return { filename: hint.endsWith('.gif') ? hintName : 'photo.gif', contentType: 'image/gif' }
  }
  if (hint.endsWith('.png')) return { filename: hintName, contentType: 'image/png' }
  if (hint.endsWith('.webp')) return { filename: hintName, contentType: 'image/webp' }
  if (hint.endsWith('.gif')) return { filename: hintName, contentType: 'image/gif' }
  return { filename: hintName || 'photo.jpg', contentType: 'image/jpeg' }
}

function parseVkUploadPayload(raw: unknown): {
  server?: number | string
  photo?: string
  hash?: string
} {
  let data: unknown = raw
  if (typeof data === 'string') {
    const trimmed = data.trim()
    if (!trimmed) return {}
    try {
      data = JSON.parse(trimmed) as unknown
    } catch {
      logger.warn('uploadVkWallPhotoFromBuffer: upload body is not JSON', {
        preview: trimmed.slice(0, 200),
      })
      return {}
    }
  }
  if (!data || typeof data !== 'object') return {}
  const obj = data as Record<string, unknown>
  return {
    server: typeof obj.server === 'number' || typeof obj.server === 'string' ? obj.server : undefined,
    photo: typeof obj.photo === 'string' ? obj.photo : undefined,
    hash: typeof obj.hash === 'string' ? obj.hash : undefined,
  }
}

/** Загружает фото на стену VK; возвращает attachment вида photo{owner_id}_{id}. */
export async function uploadVkWallPhotoFromBuffer(
  token: string,
  groupId: string,
  buffer: Buffer,
  filename = 'photo.jpg',
): Promise<string | null> {
  const groupIdNum = vkPositiveGroupId(groupId)
  try {
    if (!buffer.length) {
      logger.warn('uploadVkWallPhotoFromBuffer: empty buffer', { groupId })
      return null
    }
    const uploadServer = await vkApiCall<{ upload_url: string }>('photos.getWallUploadServer', token, {
      group_id: groupIdNum,
    })
    if (!uploadServer.upload_url) {
      logger.warn('uploadVkWallPhotoFromBuffer: empty upload_url', { groupId })
      return null
    }
    const meta = detectVkImageMeta(buffer, filename)
    const form = new FormData()
    form.append('photo', buffer, { filename: meta.filename, contentType: meta.contentType })
    const uploadRes = await axios.post(uploadServer.upload_url, form, {
      headers: form.getHeaders(),
      timeout: 120_000,
      // VK upload.php часто отдаёт text/html с JSON-телом.
      transformResponse: [(body) => body],
      responseType: 'text',
    })
    const uploaded = parseVkUploadPayload(uploadRes.data)
    const server = uploaded.server
    const photo = uploaded.photo
    const hash = uploaded.hash
    if (server == null || !photo || photo === '[]' || !hash) {
      logger.warn('uploadVkWallPhotoFromBuffer: invalid upload response', {
        groupId,
        hasServer: server != null,
        photoLen: typeof photo === 'string' ? photo.length : 0,
        hasHash: Boolean(hash),
        contentType: meta.contentType,
        bytes: buffer.length,
      })
      return null
    }
    // photo — длинный JSON; через GET query string часто обрезается → только POST.
    const saved = await vkApiCall<Array<{ owner_id: number; id: number }>>(
      'photos.saveWallPhoto',
      token,
      {
        group_id: groupIdNum,
        photo,
        server,
        hash,
      },
      { usePost: true },
    )
    const item = saved[0]
    if (!item) {
      logger.warn('uploadVkWallPhotoFromBuffer: empty saveWallPhoto response', { groupId })
      return null
    }
    return `photo${item.owner_id}_${item.id}`
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('uploadVkWallPhotoFromBuffer failed', {
      groupId,
      err: message,
      hint:
        /\[27\]|\[15\]|group auth|unavailable with group|no access to call this method/i.test(message)
          ? 'Нужен user-токен VK с правом photos (токен сообщества не умеет photos.getWallUploadServer)'
          : undefined,
    })
    return null
  }
}

/** Загружает видео в VK; возвращает attachment вида video{owner_id}_{id}. */
export async function uploadVkWallVideoFromBuffer(
  token: string,
  groupId: string,
  buffer: Buffer,
  filename = 'video.mp4',
  title = 'video',
): Promise<string | null> {
  const groupIdNum = vkPositiveGroupId(groupId)
  try {
    const saveResp = await vkApiCall<{
      upload_url: string
      video_id: number
      owner_id: number
    }>('video.save', token, {
      group_id: groupIdNum,
      name: title.slice(0, 128) || 'video',
    })
    const form = new FormData()
    form.append('video_file', buffer, { filename, contentType: 'video/mp4' })
    await axios.post(saveResp.upload_url, form, {
      headers: form.getHeaders(),
      timeout: 300_000,
    })
    return `video${saveResp.owner_id}_${saveResp.video_id}`
  } catch (err: unknown) {
    logger.warn('uploadVkWallVideoFromBuffer failed', { groupId, err })
    return null
  }
}

export async function publishVkWallPost(
  token: string,
  groupId: string,
  message: string,
  attachments?: string[],
): Promise<number | null> {
  const ownerId = groupId.startsWith('-') ? groupId : `-${groupId.replace(/^public/, '')}`
  const params: Record<string, string | number> = {
    owner_id: ownerId,
    from_group: 1,
    message,
  }
  if (attachments && attachments.length > 0) {
    params.attachments = attachments.slice(0, 10).join(',')
  }
  const response = await vkApiCall<{ post_id?: number }>('wall.post', token, params, { usePost: true })
  return response.post_id ?? null
}

function vkOwnerId(groupId: string): string {
  return groupId.startsWith('-') ? groupId : `-${groupId.replace(/^public/, '')}`
}

/** Текущий текст VK-поста на стене. */
export async function fetchVkWallPostText(
  token: string,
  groupId: string,
  postId: number,
): Promise<string | null> {
  const ownerId = vkOwnerId(groupId)
  try {
    const { data } = await httpGet<{
      response?: Array<{ text?: string }> | { items?: Array<{ text?: string }> }
      error?: { error_msg?: string }
    }>('https://api.vk.com/method/wall.getById', {
      params: {
        access_token: token,
        posts: `${ownerId}_${postId}`,
        v: '5.199',
      },
      timeout: 15_000,
    })
    if (data.error) return null
    const response = data.response
    const items = Array.isArray(response)
      ? response
      : typeof response === 'object' && response !== null && Array.isArray(response.items)
        ? response.items
        : []
    const text = items[0]?.text
    return typeof text === 'string' ? text : ''
  } catch (err: unknown) {
    logger.debug('fetchVkWallPostText failed', { groupId, postId, err })
    return null
  }
}

export async function editVkWallPostMessage(
  token: string,
  groupId: string,
  postId: number,
  message: string,
): Promise<boolean> {
  const ownerId = vkOwnerId(groupId)
  try {
    const { data } = await httpGet<{
      response?: { post_id?: number }
      error?: { error_msg?: string }
    }>('https://api.vk.com/method/wall.edit', {
      params: {
        access_token: token,
        owner_id: ownerId,
        post_id: postId,
        message,
        v: '5.199',
      },
      timeout: 15_000,
    })
    if (data.error) {
      logger.warn('editVkWallPostMessage vk error', { groupId, postId, error: data.error })
      return false
    }
    return true
  } catch (err: unknown) {
    logger.warn('editVkWallPostMessage failed', { groupId, postId, err })
    return false
  }
}

/** Дописывает маркер брони к тексту VK-поста, если его ещё нет. */
export async function appendMarkerToVkWallPost(
  token: string,
  groupId: string,
  postId: number,
  marker: string,
): Promise<boolean> {
  const current = await fetchVkWallPostText(token, groupId, postId)
  if (current == null) return false
  if (current.includes(marker)) return true
  const base = current.trim()
  const next = base ? `${base}\n\n${marker}` : marker
  return editVkWallPostMessage(token, groupId, postId, next)
}

export interface VkComment {
  id: number
  from_id: number
  date: number
  text: string
  reply_to_comment?: number
}

export async function fetchVkWallComments(
  token: string,
  groupId: string,
  postId: number,
  afterCommentId: number,
): Promise<{ comments: VkComment[]; lastCommentId: number }> {
  const ownerId = groupId.startsWith('-') ? groupId : `-${groupId.replace(/^public/, '')}`
  try {
    const { data } = await httpGet<{
      response?: { items?: Array<Record<string, unknown>> }
      error?: { error_msg?: string }
    }>('https://api.vk.com/method/wall.getComments', {
      params: {
        access_token: token,
        owner_id: ownerId,
        post_id: postId,
        count: 100,
        sort: 'asc',
        thread_items_count: 10,
        v: '5.199',
      },
      timeout: 15_000,
    })
    if (data.error || !data.response?.items) {
      return { comments: [], lastCommentId: afterCommentId }
    }
    const comments: VkComment[] = []
    let maxId = afterCommentId
    for (const item of data.response.items) {
      const id = typeof item.id === 'number' ? item.id : 0
      if (id > maxId) maxId = id
      if (id <= afterCommentId) continue
      const text = typeof item.text === 'string' ? item.text : ''
      if (!text.trim()) continue
      comments.push({
        id,
        from_id: typeof item.from_id === 'number' ? item.from_id : 0,
        date: typeof item.date === 'number' ? item.date : 0,
        text,
        reply_to_comment:
          typeof item.reply_to_comment === 'number' ? item.reply_to_comment : undefined,
      })
    }
    return { comments, lastCommentId: maxId }
  } catch (err: unknown) {
    logger.warn('fetchVkWallComments failed', { groupId, postId, err })
    return { comments: [], lastCommentId: afterCommentId }
  }
}

export async function publishVkWallComment(
  token: string,
  groupId: string,
  postId: number,
  message: string,
  replyToCommentId?: number,
): Promise<number | null> {
  const ownerId = groupId.startsWith('-') ? groupId : `-${groupId.replace(/^public/, '')}`
  try {
    const params: Record<string, string | number> = {
      access_token: token,
      owner_id: ownerId,
      post_id: postId,
      message,
      from_group: Number(Math.abs(Number(ownerId))),
      v: '5.199',
    }
    if (replyToCommentId != null && replyToCommentId > 0) {
      params.reply_to_comment = replyToCommentId
    }
    const { data } = await httpGet<{
      response?: { comment_id?: number }
      error?: { error_msg?: string }
    }>('https://api.vk.com/method/wall.createComment', { params, timeout: 15_000 })
    if (data.error) {
      logger.warn('publishVkWallComment failed', { error: data.error.error_msg })
      return null
    }
    return data.response?.comment_id ?? null
  } catch (err: unknown) {
    logger.warn('publishVkWallComment threw', { groupId, postId, err })
    return null
  }
}
