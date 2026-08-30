import { telegramAxios as axios } from '../utils/telegramAxios'
import type { Bot } from '@maxhub/max-bot-api'

import { integrationsStore } from './integrationsStore'
import { resolveTelegramBotToken } from './resolveTelegramBotToken'
import {
  enrichTelegramChatsWithBotAdmin,
  listTelegramBotChats,
  getTelegramBotUserId,
  listTelegramChatAdministrators,
  resolveTelegramChannelChatIdFromKey,
  type PlatformChannelInfo,
} from './integrationPlatformClient'
import { ownerProfileStore } from './ownerProfileStore'
import { telegramBotUserStore } from './telegramBotUserStore'
import { telegramChannelNotifyLinkStore } from './telegramChannelNotifyLinkStore'
import { telegramChannelRegistry } from './telegramChannelRegistry'
import { commentStore } from './commentStore'
import { postStore } from './postStore'
import { subscriberStore } from './subscriberStore'
import { ensureAdminPanelStateLoaded, listTgChainsSync } from '../api/adminPanelState'
import { completeAccountPairingFromTelegram } from './accountPairingService'
import { buildTelegramBotJoinUrl, isTelegramAccountPairStartPayload } from '../utils/telegramDeeplink'
import {
  handleTelegramCallbackQuery,
  handleTelegramMyChatMemberUpdate,
  handleTelegramPrivateMessage,
  reconcileTelegramChannelForMiniappUser,
  tryActivateTelegramChannelRegistration,
} from './telegramChannelActivation'
import {
  handleTelegramCommentModerationCallback,
  tryHandleTelegramCommentModerationReply,
} from './telegramCommentModerationService'
import { profilePairingForPlatformUser } from './channelLinkAdminTeamSync'
import {
  buildTelegramOpenPanelButton,
  isTelegramWebAppUrl,
  normalizeMiniAppUrl,
  withTelegramMiniappPlatform,
} from '../utils/telegramMiniAppUrl'
import { config } from '../config'
import { logger } from '../utils/logger'
import {
  cacheDelete,
  cacheGetJson,
  cacheGetOrCompute,
  cacheSetJson,
} from '../cache/tieredCache'

const TG_API = 'https://api.telegram.org/bot'

/** Same ballpark as Max miniapp admin-channels cache — keeps TG home snappy. */
const TG_MINIAPP_CHANNELS_TTL_SEC = 120
const TG_DISCOVERY_TTL_SEC = 60
const TG_ADMIN_CHECK_TTL_SEC = 90

export interface TelegramMiniappChannelWire {
  chat_id: string
  title: string | null
  subscribers: number | null
  avatar_url: string | null
  status: 'pending' | 'active'
  platform: 'telegram'
}

type TelegramMiniappChannelsPayload = {
  channels: TelegramMiniappChannelWire[]
  bot_username: string
}

const listChannelsInFlight = new Map<number, Promise<TelegramMiniappChannelsPayload>>()

function tgChannelsCacheKey(telegramUserId: number): string {
  return `miniapp:tg-channels:${telegramUserId}`
}

function tgAdminCheckCacheKey(chatId: string, telegramUserId: number): string {
  return `miniapp:tg-admin:${chatId}:${telegramUserId}`
}

export async function invalidateTelegramMiniappChannelsCache(
  telegramUserId?: number,
): Promise<void> {
  if (telegramUserId != null) {
    listChannelsInFlight.delete(telegramUserId)
    await cacheDelete(tgChannelsCacheKey(telegramUserId))
  }
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
): Promise<void> {
  await axios.post(
    `${TG_API}${token}/answerCallbackQuery`,
    { callback_query_id: callbackQueryId },
    { timeout: 10_000 },
  )
}

function buildTelegramMiniAppHomeUrl(): string | null {
  const fromConfig = config.miniAppUrl?.trim()
  if (fromConfig && isTelegramWebAppUrl(fromConfig)) {
    return withTelegramMiniappPlatform(normalizeMiniAppUrl(fromConfig) ?? fromConfig)
  }
  const fromEnv = normalizeMiniAppUrl(process.env.MINI_APP_URL ?? '')
  if (fromEnv && isTelegramWebAppUrl(fromEnv)) {
    return withTelegramMiniappPlatform(fromEnv)
  }
  return null
}

function buildTelegramStartInlineKeyboard(
  homeUrl: string | null,
  options?: { includeHowItWorks?: boolean },
): { inline_keyboard: Array<Array<Record<string, unknown>>> } {
  const openBtn = buildTelegramOpenPanelButton(homeUrl)
  const rows: Array<Array<Record<string, unknown>>> = [[openBtn]]
  if (options?.includeHowItWorks !== false) {
    rows.push([{ text: '📖 Как это работает', callback_data: 'tg_how_it_works' }])
  }
  return { inline_keyboard: rows }
}

function resolveTelegramUserFirstName(from: Record<string, unknown> | undefined): string {
  const first = typeof from?.first_name === 'string' ? from.first_name.trim() : ''
  if (first) {
    return first
  }
  const username = typeof from?.username === 'string' ? from.username.trim() : ''
  if (username) {
    return username
  }
  return 'друг'
}

async function getTelegramUserActivitySummary(telegramUserId: number): Promise<{
  channelsCount: number
  linksCount: number
  notifyLinksCount: number
  isActive: boolean
}> {
  const token = resolveTelegramBotToken()
  const notifyLinks = telegramChannelNotifyLinkStore.getLinkedChannels(telegramUserId)
  if (!token) {
    const notifyLinksCount = notifyLinks.length
    return {
      channelsCount: 0,
      linksCount: 0,
      notifyLinksCount,
      isActive: notifyLinksCount > 0,
    }
  }
  await integrationsStore.load()
  const { channels } = await listTelegramMiniappChannelsForUser(telegramUserId)
  await ensureAdminPanelStateLoaded()
  const adminTgIds = new Set(channels.map((c) => c.chat_id))
  const linksCount = listTgChainsSync().filter((c) => {
    const id = c.tg_channel_id?.trim()
    return Boolean(id && adminTgIds.has(id))
  }).length
  const channelsCount = channels.length
  const notifyLinksCount = notifyLinks.length
  return {
    channelsCount,
    linksCount,
    notifyLinksCount,
    isActive: channelsCount > 0 || linksCount > 0 || notifyLinksCount > 0,
  }
}

export async function sendTelegramHowItWorksMessage(
  token: string,
  telegramUserId: number,
): Promise<void> {
  const homeUrl = buildTelegramMiniAppHomeUrl()
  const text =
    `📖 Как работает CommentBot в Telegram:\n\n` +
    `1️⃣ Добавьте @commentvmax_bot в канал и выдайте права администратора\n` +
    `2️⃣ В мини-приложении создайте связку с каналом в MAX\n` +
    `3️⃣ Посты из Telegram пересылаются в MAX, под ними — кнопка «Комментарии»\n` +
    `4️⃣ Вы получаете уведомления о новых комментариях\n` +
    `5️⃣ Отвечаете из одной панели — в Telegram и MAX`
  await sendTelegramBotMessage(token, telegramUserId, text, {
    reply_markup: buildTelegramStartInlineKeyboard(homeUrl, { includeHowItWorks: false }),
  })
}

export async function handleTelegramBotStartWelcome(
  telegramUserId: number,
  from?: Record<string, unknown>,
): Promise<void> {
  const token = resolveTelegramBotToken()
  if (!token) {
    return
  }
  const firstName = resolveTelegramUserFirstName(from)
  const homeUrl = buildTelegramMiniAppHomeUrl()
  const activity = await getTelegramUserActivitySummary(telegramUserId)

  if (!activity.isActive) {
    const text =
      `👋 Привет, ${firstName}!\n\n` +
      `Я CommentBot — помогу связать ваш канал в Telegram с каналом в MAX.\n\n` +
      `Что можно сделать:\n` +
      `📢 Подключить Telegram-канал к боту\n` +
      `🔗 Создать связку TG ↔ MAX\n` +
      `🔔 Получать уведомления о комментариях\n\n` +
      `Нажмите кнопку ниже — откроется панель с пошаговым подключением.`
    await sendTelegramBotMessage(token, telegramUserId, text, {
      reply_markup: buildTelegramStartInlineKeyboard(homeUrl),
    })
    return
  }

  const parts: string[] = []
  if (activity.channelsCount > 0) {
    parts.push(
      `${activity.channelsCount} ${activity.channelsCount === 1 ? 'канал' : activity.channelsCount < 5 ? 'канала' : 'каналов'}`,
    )
  }
  if (activity.linksCount > 0) {
    parts.push(
      `${activity.linksCount} ${activity.linksCount === 1 ? 'связка' : activity.linksCount < 5 ? 'связки' : 'связок'}`,
    )
  }
  if (activity.notifyLinksCount > 0 && activity.channelsCount === 0) {
    parts.push('уведомления включены')
  }
  const summary = parts.length > 0 ? parts.join(' · ') : 'есть подключения'

  const text =
    `👋 С возвращением, ${firstName}!\n\n` +
    `У вас уже настроено: ${summary}.\n\n` +
    `Откройте панель в мини-приложении — там каналы, связки TG↔MAX, статистика и настройки уведомлений.`
  await sendTelegramBotMessage(token, telegramUserId, text, {
    reply_markup: buildTelegramStartInlineKeyboard(homeUrl, { includeHowItWorks: false }),
  })
}

async function isTelegramChannelAdmin(
  token: string,
  channelChatId: string,
  telegramUserId: number,
): Promise<boolean> {
  const admins = await listTelegramChatAdministrators(token, channelChatId)
  return admins.some((a) => a.userId === telegramUserId)
}

async function isTelegramChannelAdminCached(
  token: string,
  channelChatId: string,
  telegramUserId: number,
): Promise<boolean> {
  return cacheGetOrCompute(
    tgAdminCheckCacheKey(channelChatId, telegramUserId),
    TG_ADMIN_CHECK_TTL_SEC,
    () => isTelegramChannelAdmin(token, channelChatId, telegramUserId),
  )
}

/** Heavy TG Bot API discovery — throttled so home/stats/links don't all re-run getUpdates.
 *  @returns true when discovery actually ran */
async function maybeRefreshTelegramChannelsCache(
  token: string,
  telegramUserId: number,
  force: boolean,
): Promise<boolean> {
  if (force) {
    await refreshTelegramChannelsCache(token, telegramUserId)
    await cacheSetJson('miniapp:tg-discovery:global', { at: Date.now() }, TG_DISCOVERY_TTL_SEC)
    return true
  }
  const existing = await cacheGetJson<{ at: number }>('miniapp:tg-discovery:global')
  if (existing) {
    return false
  }
  await cacheGetOrCompute('miniapp:tg-discovery:global', TG_DISCOVERY_TTL_SEC, async () => {
    await refreshTelegramChannelsCache(token, telegramUserId)
    return { at: Date.now() }
  })
  return true
}

function isNumericTelegramChatId(raw: string): boolean {
  return /^-?\d+$/.test(String(raw).trim())
}

/** Каналы из реестра, integrations, связок TG↔MAX и персональных notify-link. */
function collectTelegramMiniappChannelCandidateIds(telegramUserId?: number): string[] {
  const ids = new Set<string>()
  for (const row of telegramChannelRegistry.getAllChannels()) {
    if (row.type === 'channel' || row.type === 'supergroup') {
      ids.add(row.chat_id)
    }
  }
  const integ = integrationsStore.getTelegramIntegration()
  for (const ch of integ?.linkedChats ?? []) {
    const id = String(ch.id ?? '').trim()
    if (isNumericTelegramChatId(id)) {
      ids.add(id)
    }
  }
  for (const chain of listTgChainsSync()) {
    const id = chain.tg_channel_id?.trim() ?? ''
    if (isNumericTelegramChatId(id)) {
      ids.add(id)
    }
  }
  if (telegramUserId != null) {
    for (const chId of telegramChannelNotifyLinkStore.getLinkedChannels(telegramUserId)) {
      if (isNumericTelegramChatId(chId)) {
        ids.add(chId)
      }
    }
  }
  return [...ids]
}

async function persistEnrichedTelegramChannels(
  token: string,
  chatIds: string[],
): Promise<void> {
  if (chatIds.length === 0) {
    return
  }
  const stubs: PlatformChannelInfo[] = chatIds.map((id) => {
    const reg = telegramChannelRegistry.getChannel(id)
    return {
      id,
      title: reg?.title?.trim() || id,
      username: reg?.username ?? undefined,
      type: reg?.type === 'supergroup' ? 'supergroup' : 'channel',
    }
  })
  const enriched = await enrichTelegramChatsWithBotAdmin(token, stubs)
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

function saveDiscoveredTelegramChannels(channels: PlatformChannelInfo[]): void {
  for (const ch of channels) {
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

async function refreshTelegramChannelsCache(
  token: string,
  telegramUserId?: number,
): Promise<void> {
  await integrationsStore.load()
  await ensureAdminPanelStateLoaded()

  try {
    const { syncMainTelegramBotDiscoveryUpdates } = await import('./tgChainForwarder')
    await syncMainTelegramBotDiscoveryUpdates(token, { timeoutSec: 0, maxPages: 8 })
  } catch (err: unknown) {
    logger.warn('refreshTelegramChannelsCache: sync main bot updates failed', { err })
  }

  const integration = integrationsStore.getTelegramIntegration()
  const discovered = await enrichTelegramChatsWithBotAdmin(
    token,
    await listTelegramBotChats(token, integration?.id),
  )
  saveDiscoveredTelegramChannels(discovered)

  const knownIds = collectTelegramMiniappChannelCandidateIds(telegramUserId)
  await persistEnrichedTelegramChannels(token, knownIds)
}

/** Ручное добавление канала по @username или -100… (если бот уже админ, но канал не в списке). */
export async function registerTelegramChannelByKeyForMiniappUser(
  telegramUserId: number,
  channelKeyRaw: string,
): Promise<TelegramMiniappChannelWire> {
  const token = resolveTelegramBotToken()
  if (!token) {
    throw new Error('telegram not configured')
  }
  const resolved = await resolveTelegramChannelChatIdFromKey(token, channelKeyRaw)
  if (!resolved) {
    throw new Error('channel not found')
  }
  if (resolved.type !== 'channel' && resolved.type !== 'supergroup') {
    throw new Error('not a channel')
  }

  telegramChannelRegistry.saveChannel({
    chatId: resolved.chatId,
    title: resolved.title,
    username: resolved.username,
    type: resolved.type,
    botIsAdmin: false,
  })

  const enriched = await enrichTelegramChatsWithBotAdmin(token, [
    {
      id: resolved.chatId,
      title: resolved.title ?? resolved.chatId,
      username: resolved.username ?? undefined,
      type: resolved.type,
    },
  ])
  saveDiscoveredTelegramChannels(enriched)

  if (!(await isTelegramChannelAdmin(token, resolved.chatId, telegramUserId))) {
    throw new Error('forbidden')
  }

  await tryActivateTelegramChannelRegistration(resolved.chatId, telegramUserId, {
    notify: false,
  })

  await cacheDelete(tgAdminCheckCacheKey(resolved.chatId, telegramUserId))
  await invalidateTelegramMiniappChannelsCache(telegramUserId)

  const fresh = telegramChannelRegistry.getChannel(resolved.chatId)
  return {
    chat_id: resolved.chatId,
    title: fresh?.title ?? resolved.title,
    subscribers: null,
    avatar_url: null,
    status: fresh?.bot_is_admin ? 'active' : 'pending',
    platform: 'telegram',
  }
}

async function computeTelegramMiniappChannelsForUser(
  token: string,
  telegramUserId: number,
  options?: { forceRefresh?: boolean },
): Promise<TelegramMiniappChannelsPayload> {
  await integrationsStore.load()
  await ensureAdminPanelStateLoaded()

  if (options?.forceRefresh) {
    await maybeRefreshTelegramChannelsCache(token, telegramUserId, true)
  } else {
    // Match Max: serve from registry immediately; throttle discovery off the request path.
    void maybeRefreshTelegramChannelsCache(token, telegramUserId, false)
      .then(async (didRefresh) => {
        if (didRefresh) {
          await invalidateTelegramMiniappChannelsCache(telegramUserId)
        }
      })
      .catch((err: unknown) => {
        logger.warn('telegram miniapp background discovery failed', { telegramUserId, err })
      })
  }

  const candidates = collectTelegramMiniappChannelCandidateIds(telegramUserId)
  const seen = new Set<string>()
  const uniqueIds: string[] = []
  for (const chatId of candidates) {
    if (seen.has(chatId)) continue
    seen.add(chatId)
    const row = telegramChannelRegistry.getChannel(chatId)
    const type = row?.type ?? 'channel'
    if (type !== 'channel' && type !== 'supergroup') continue
    uniqueIds.push(chatId)
  }

  const adminFlags = await Promise.all(
    uniqueIds.map(async (chatId) => ({
      chatId,
      isAdmin: await isTelegramChannelAdminCached(token, chatId, telegramUserId),
    })),
  )

  const channels: TelegramMiniappChannelWire[] = []
  const toReconcile: string[] = []
  for (const { chatId, isAdmin } of adminFlags) {
    if (!isAdmin) continue
    toReconcile.push(chatId)
    const row = telegramChannelRegistry.getChannel(chatId)
    channels.push({
      chat_id: chatId,
      title: row?.title ?? null,
      subscribers: null,
      avatar_url: null,
      status: row?.bot_is_admin ? 'active' : 'pending',
      platform: 'telegram',
    })
  }

  // Activation side-effects off the request path (was 2× getChatAdministrators per channel).
  if (toReconcile.length > 0) {
    void Promise.all(
      toReconcile.map((chatId) =>
        reconcileTelegramChannelForMiniappUser(chatId, telegramUserId).catch((err: unknown) => {
          logger.warn('telegram miniapp reconcile failed', { chatId, telegramUserId, err })
        }),
      ),
    )
  }

  return { channels, bot_username: 'commentvmax_bot' }
}

export async function listTelegramMiniappChannelsForUser(
  telegramUserId: number,
  options?: { forceRefresh?: boolean },
): Promise<TelegramMiniappChannelsPayload> {
  const token = resolveTelegramBotToken()
  if (!token) {
    return { channels: [], bot_username: 'commentvmax_bot' }
  }

  const cacheKey = tgChannelsCacheKey(telegramUserId)
  if (!options?.forceRefresh) {
    const cached = await cacheGetJson<TelegramMiniappChannelsPayload>(cacheKey)
    if (cached) {
      return cached
    }
    const inFlight = listChannelsInFlight.get(telegramUserId)
    if (inFlight) {
      return inFlight
    }
  }

  const compute = (async () => {
    const payload = await computeTelegramMiniappChannelsForUser(token, telegramUserId, options)
    await cacheSetJson(cacheKey, payload, TG_MINIAPP_CHANNELS_TTL_SEC)
    return payload
  })()

  if (!options?.forceRefresh) {
    listChannelsInFlight.set(telegramUserId, compute)
  }
  try {
    return await compute
  } finally {
    if (listChannelsInFlight.get(telegramUserId) === compute) {
      listChannelsInFlight.delete(telegramUserId)
    }
  }
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
    paired: boolean
    max_user_id: number | null
    tg_user_id: number | null
    peer_platform: 'max' | 'telegram' | null
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

  const [rows, botUserId] = await Promise.all([
    listTelegramChatAdministrators(token, chatId),
    getTelegramBotUserId(token),
  ])
  const linkedIds = new Set(telegramChannelNotifyLinkStore.getUserIdsForChannel(chatId))
  const admins = rows
    .filter((a) => botUserId == null || a.userId !== botUserId)
    .map((a) => {
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
    const pairing = profilePairingForPlatformUser('telegram', a.userId)
    const peerPlatform =
      pairing.max_user_id != null ? ('max' as const) : pairing.paired ? ('max' as const) : null
    return {
      user_id: a.userId,
      name,
      initials,
      linked: linkedIds.has(a.userId),
      paired: pairing.paired,
      max_user_id: pairing.max_user_id,
      tg_user_id: pairing.tg_user_id,
      peer_platform: peerPlatform,
    }
    })

  return {
    admins,
    invite_url: buildTelegramBotJoinUrl(chatId),
  }
}

function telegramChannelInviteFailureMessage(error: string): string {
  if (error === 'bot is not channel administrator') {
    return (
      'Не удалось подключить канал. Убедитесь, что @commentvmax_bot добавлен в Telegram-канал ' +
      'как администратор, затем нажмите «Подтвердить подключение» в личке с ботом или отправьте /connect.'
    )
  }
  if (error === 'channel is not connected to this bot') {
    return (
      'Не удалось подключить канал. Сначала добавьте @commentvmax_bot в связанный Telegram-канал ' +
      'как администратора — после этого снова откройте ссылку из MAX.'
    )
  }
  return 'Не удалось подключить канал. Проверьте, что бот добавлен в канал как администратор.'
}

export async function resolveTelegramChannelInviteAccess(
  telegramUserId: number,
  joinChannelIdRaw: string,
): Promise<
  | { ok: true; channelChatId: string; title: string | null }
  | { ok: false; status: 400 | 403 | 404; error: string }
> {
  const chatId = String(joinChannelIdRaw).trim()
  if (!/^-?\d+$/.test(chatId)) {
    return { ok: false, status: 400, error: 'missing or invalid join_channel_id' }
  }

  let reg = telegramChannelRegistry.getChannel(chatId)
  if (!reg || !reg.bot_is_admin) {
    await tryActivateTelegramChannelRegistration(chatId, telegramUserId)
    reg = telegramChannelRegistry.getChannel(chatId)
  }

  if (!reg) {
    logger.warn('resolveTelegramChannelInviteAccess: channel unknown after activation', {
      chatId,
      telegramUserId,
    })
    return { ok: false, status: 404, error: 'channel is not connected to this bot' }
  }
  if (!reg.bot_is_admin) {
    logger.warn('resolveTelegramChannelInviteAccess: bot not channel admin', {
      chatId,
      telegramUserId,
    })
    return { ok: false, status: 403, error: 'bot is not channel administrator' }
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

/** Личные сообщения в Telegram-боте после успешной связки TG ↔ MAX. */
export async function notifyChannelLinkSucceededPrivate(params: {
  profileId: string
  maxUserId: number
  maxTitle: string | null
  tgTitle: string
  confirmedByTgUserId: number
}): Promise<void> {
  const token = resolveTelegramBotToken()
  if (!token) {
    return
  }

  const maxTitle = (params.maxTitle && params.maxTitle.trim()) || 'MAX-канал'
  const tgTitle = (params.tgTitle && params.tgTitle.trim()) || 'Telegram-канал'
  const homeUrl = buildTelegramMiniAppHomeUrl()
  const keyboard = buildTelegramStartInlineKeyboard(homeUrl, { includeHowItWorks: false })

  const accounts = ownerProfileStore.getAccountsForProfile(params.profileId)
  const maxOnProfile = accounts.some(
    (a) => a.platform === 'max' && a.platform_user_id === String(params.maxUserId),
  )

  const recipientRoles = new Map<number, 'confirmer' | 'max_initiator'>()
  recipientRoles.set(params.confirmedByTgUserId, 'confirmer')

  for (const acc of accounts) {
    if (acc.platform !== 'telegram') {
      continue
    }
    const tgId = Number.parseInt(acc.platform_user_id, 10)
    if (!Number.isInteger(tgId) || tgId <= 0) {
      continue
    }
    if (tgId === params.confirmedByTgUserId) {
      recipientRoles.set(tgId, 'confirmer')
    } else if (maxOnProfile) {
      recipientRoles.set(tgId, 'max_initiator')
    }
  }

  telegramBotUserStore.markStarted({ id: params.confirmedByTgUserId })

  for (const [tgId, role] of recipientRoles) {
    const text =
      role === 'max_initiator'
        ? `✅ Связка с Telegram завершена!\n\n📺 MAX: «${maxTitle}»\n📱 Telegram: «${tgTitle}»\n\nПосты из Telegram будут пересылаться в ваш MAX-канал.`
        : `✅ Связка создана!\n\n📱 Telegram: «${tgTitle}»\n📺 MAX: «${maxTitle}»\n\nПосты из Telegram будут пересылаться в MAX.`
    try {
      await sendTelegramBotMessage(token, tgId, text, { reply_markup: keyboard })
      logger.info('notifyChannelLinkSucceededPrivate: sent', { tgId, role })
    } catch (err: unknown) {
      logger.warn('notifyChannelLinkSucceededPrivate: send failed', { tgId, role, err })
    }
  }
}

export async function handleTelegramBotAccountPair(
  telegramUserId: number,
  from: Record<string, unknown>,
  startPayload: string,
): Promise<void> {
  const token = resolveTelegramBotToken()
  const firstName = typeof from.first_name === 'string' ? from.first_name : null
  const lastName = typeof from.last_name === 'string' ? from.last_name : null
  const username = typeof from.username === 'string' ? from.username : null
  try {
    await completeAccountPairingFromTelegram(startPayload, {
      platform: 'telegram',
      platformUserId: telegramUserId,
      username,
      firstName,
      lastName,
      photoUrl: null,
    })
    const homeUrl = buildTelegramMiniAppHomeUrl()
    await sendTelegramBotMessage(
      token,
      telegramUserId,
      '✅ Telegram привязан к вашему MAX-аккаунту!\n\n' +
        'Теперь команда канала видит связку в списке админов. Откройте мини-приложение — статус обновится автоматически.',
      { reply_markup: buildTelegramStartInlineKeyboard(homeUrl, { includeHowItWorks: false }) },
    )
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    let text = 'Не удалось привязать Telegram. Ссылка могла устареть — создайте новую в MAX.'
    if (msg === 'pairing token expired') {
      text = 'Ссылка устарела. В MAX нажмите «Связать Telegram» ещё раз.'
    } else if (msg === 'pairing token already used') {
      text = 'Эта ссылка уже использована. Если нужно — создайте новую в MAX.'
    } else if (msg === 'telegram already linked') {
      text = 'Telegram уже привязан к профилю.'
    }
    await sendTelegramBotMessage(token, telegramUserId, text)
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
    logger.info('handleTelegramBotStartJoin: access denied', {
      telegramUserId,
      channelChatId,
      error: access.error,
      status: access.status,
    })
    await sendTelegramBotMessage(
      token,
      telegramUserId,
      telegramChannelInviteFailureMessage(access.error),
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

export async function processTelegramMiniappBotUpdates(
  token: string,
  updates: Array<Record<string, unknown>>,
  bot: Bot | null = null,
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
    if (upd.callback_query) {
      const cq = upd.callback_query as Record<string, unknown>
      const cqData = typeof cq.data === 'string' ? cq.data.trim() : ''
      const cqFrom = cq.from as Record<string, unknown> | undefined
      const cqUserId = typeof cqFrom?.id === 'number' ? cqFrom.id : null
      const cqId = typeof cq.id === 'string' ? cq.id : null
      if (cqData === 'tg_how_it_works' && cqUserId != null && cqId) {
        try {
          await answerTelegramCallbackQuery(token, cqId)
        } catch (err: unknown) {
          logger.warn('processTelegramMiniappBotUpdates: answer tg_how_it_works failed', { err })
        }
        await sendTelegramHowItWorksMessage(token, cqUserId)
        continue
      }
      if (bot && (await handleTelegramCommentModerationCallback(upd, bot))) {
        continue
      }
      await handleTelegramCallbackQuery(upd)
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
    subscriberStore.addSubscriber(from.id)

    if (text.startsWith('/start')) {
      const payload = text.replace(/^\/start\s*/i, '').trim()
      if (isTelegramAccountPairStartPayload(payload)) {
        await handleTelegramBotAccountPair(from.id, from, payload)
        continue
      }
      if (/^jointg\d+$/i.test(payload)) {
        await handleTelegramBotStartJoin(from.id, payload)
        continue
      }
      if (/^linkmax$/i.test(payload)) {
        const homeUrl = buildTelegramMiniAppHomeUrl()
        await sendTelegramBotMessage(
          token,
          from.id,
          '🔗 Связка с MAX\n\nОткройте мини-приложение CommentBot → «Создать связку» → выберите Telegram-канал и введите код из MAX.',
          {
            reply_markup: buildTelegramStartInlineKeyboard(homeUrl, { includeHowItWorks: false }),
          },
        )
        continue
      }
      await handleTelegramBotStartWelcome(from.id, from)
      continue
    }

    if (text) {
      if (bot && (await tryHandleTelegramCommentModerationReply(bot, from.id, text))) {
        continue
      }
      await handleTelegramPrivateMessage(from.id, text)
    }
  }
}
