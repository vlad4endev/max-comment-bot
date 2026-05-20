import type { Bot } from '@maxhub/max-bot-api'

import { adminRuntimeSettingsStore } from './adminRuntimeSettingsStore'
import { clearAdminJoinNotifiedForChannel } from './channelAdminJoinNotified'
import type { ChannelRecord } from './channelRegistry'
import { channelRegistry } from './channelRegistry'
import { scheduleCommentButtonRetry } from './commentButtonRetryQueue'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { logger } from '../utils/logger'
import { apiCallWithRetry } from '../utils/maxApiRetry'
import {
  loadChannelPostMessage,
  tryAttachCommentsToChannelPost,
  type AttachChannelCommentsResult,
} from './channelPostActions'
import { isMiniAppOpenUrlConfigured, postStore } from './postStore'

const MIN_POLL_INTERVAL_MS = 3_000
/** Верхняя граница интервала опроса одного канала (стабильность важнее редкого глобального 30 с). */
const PER_CHANNEL_CAP_MS = 6_000
const FETCH_COUNT = 15
/** Admin «обновить кнопки» scans more history than the periodic poller. */
const REFRESH_BUTTONS_FETCH_COUNT = 100
/** Exported for startup diagnostics. */
export const POLL_CONCURRENCY = 8
const DISABLE_AFTER_ERRORS = 5

const channelTimers = new Map<number, ReturnType<typeof setInterval>>()
const errorCount = new Map<number, number>()
let botRef: Bot | null = null
let perChannelIntervalMs = PER_CHANNEL_CAP_MS

function resolvePerChannelIntervalMs(globalMs: number): number {
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(globalMs, PER_CHANNEL_CAP_MS))
}

async function pollChannel(
  bot: Bot,
  channel: ChannelRecord,
  botUid: number | undefined,
): Promise<{ fetched: number; candidates: number; attached: number; failed: number }> {
  const stats = { fetched: 0, candidates: 0, attached: 0, failed: 0 }
  const { messages } = await apiCallWithRetry(() =>
    bot.api.getMessages(channel.chat_id, { count: FETCH_COUNT }),
  )
  stats.fetched = messages.length

  for (const message of messages) {
    const mid = message.body?.mid
    if (typeof mid !== 'string' || mid.trim() === '') {
      continue
    }
    const knownPost = postStore.findPostByChannelMessage(channel.chat_id, mid)
    if (knownPost && knownPost.button_attach_pending !== true) {
      continue
    }
    stats.candidates += 1
    const r = await tryAttachCommentsToChannelPost(bot, message, {
      botUserId: botUid,
      channelChatIdOverride: channel.chat_id,
      skipAuthorAdminCheck: true,
      source: 'poller',
    })
    if (r.ok) {
      stats.attached += 1
    } else if (r.reason === 'attach_failed') {
      stats.failed += 1
      scheduleCommentButtonRetry(channel.chat_id, mid)
    }
  }

  if (stats.candidates > 0 || stats.attached > 0) {
    logger.info('channelPoller: channel sweep', {
      chatId: channel.chat_id,
      ...stats,
    })
  }
  return stats
}

async function pollChannelSafe(bot: Bot, channel: ChannelRecord, botUid: number | undefined): Promise<void> {
  try {
    await pollChannel(bot, channel, botUid)
    errorCount.delete(channel.chat_id)
  } catch (err: unknown) {
    const count = (errorCount.get(channel.chat_id) ?? 0) + 1
    errorCount.set(channel.chat_id, count)
    logger.error(
      `channelPoller: error for ${channel.chat_id} (${count}/${DISABLE_AFTER_ERRORS})`,
      err,
    )

    if (count >= DISABLE_AFTER_ERRORS) {
      logger.warn(
        `channelPoller: disabling channel ${channel.chat_id} after ${count} errors`,
      )
      clearAdminJoinNotifiedForChannel(channel.chat_id)
      channelRegistry.deactivate(channel.chat_id)
      errorCount.delete(channel.chat_id)
      stopChannelTimer(channel.chat_id)
    }
  }
}

function stopChannelTimer(chatId: number): void {
  const t = channelTimers.get(chatId)
  if (t !== undefined) {
    clearInterval(t)
    channelTimers.delete(chatId)
  }
}

/**
 * У каждого канала свой таймер — очередь не блокирует «хвостовые» каналы на минуты.
 */
export function syncPerChannelPollers(bot: Bot): void {
  if (!isMiniAppOpenUrlConfigured()) {
    return
  }
  botRef = bot
  const channels = channelRegistry.getAllChannels().filter((c) => c.type === 'channel')
  const activeIds = new Set(channels.map((c) => c.chat_id))
  for (const chatId of [...channelTimers.keys()]) {
    if (!activeIds.has(chatId)) {
      stopChannelTimer(chatId)
    }
  }
  const botUid = bot.botInfo?.user_id
  for (const channel of channels) {
    if (channelTimers.has(channel.chat_id)) {
      continue
    }
    void pollChannelSafe(bot, channel, botUid)
    const timer = setInterval(() => {
      if (!botRef) {
        return
      }
      void pollChannelSafe(botRef, channel, botRef.botInfo?.user_id)
    }, perChannelIntervalMs)
    channelTimers.set(channel.chat_id, timer)
  }
  logger.info('channelPoller: per-channel timers synced', {
    channelCount: channels.length,
    perChannelIntervalMs,
    fetchCount: FETCH_COUNT,
  })
}

export interface RefreshButtonsStats {
  chat_id: number
  messages_fetched: number
  /** Постов в базе бота для этого канала (перепривязка кнопки по каждому). */
  posts_in_db: number
  created: number
  refreshed: number
  skipped: number
  failed: number
}

function applyRefreshAttachResult(
  stats: RefreshButtonsStats,
  r: AttachChannelCommentsResult,
  wasInDb: boolean,
): void {
  if (r.ok) {
    if (wasInDb) {
      stats.refreshed += 1
    } else {
      stats.created += 1
    }
    return
  }
  if (r.reason === 'already_exists') {
    stats.refreshed += 1
    return
  }
  if (
    r.reason === 'skip_bot' ||
    r.reason === 'no_mid' ||
    r.reason === 'no_chat_id' ||
    r.reason === 'not_admin'
  ) {
    stats.skipped += 1
    return
  }
  stats.failed += 1
}

export class RefreshButtonsError extends Error {
  constructor(
    readonly code: 'miniapp_not_configured' | 'channel_not_found' | 'api_error',
    message: string,
  ) {
    super(message)
    this.name = 'RefreshButtonsError'
  }
}

/**
 * One sweep for a single channel (admin «обновить кнопки»).
 */
export async function runChannelPollerForChat(
  bot: Bot,
  chatId: number,
): Promise<RefreshButtonsStats> {
  if (!isMiniAppOpenUrlConfigured()) {
    throw new RefreshButtonsError(
      'miniapp_not_configured',
      'Не заданы BOT_NICKNAME или MINI_APP_URL — ссылки на Mini App недоступны',
    )
  }

  const canonicalChatId = resolveCanonicalChannelChatId(chatId) ?? chatId
  const reg = channelRegistry.getChannel(canonicalChatId) ?? channelRegistry.getChannel(chatId)
  if (!reg || reg.type !== 'channel') {
    throw new RefreshButtonsError('channel_not_found', 'Канал не найден в реестре бота')
  }

  const stats: RefreshButtonsStats = {
    chat_id: reg.chat_id,
    messages_fetched: 0,
    posts_in_db: 0,
    created: 0,
    refreshed: 0,
    skipped: 0,
    failed: 0,
  }

  const botUid = bot.botInfo?.user_id
  const knownPosts = postStore.getPostsByChatId(reg.chat_id)
  stats.posts_in_db = knownPosts.length
  const processedMids = new Set<string>()

  for (const post of knownPosts) {
    processedMids.add(post.message_mid)
    if (post.comments_ui_message_mid) {
      processedMids.add(post.comments_ui_message_mid)
    }
    const message = await loadChannelPostMessage(bot, post)
    if (!message?.body?.mid) {
      stats.failed += 1
      scheduleCommentButtonRetry(reg.chat_id, post.message_mid)
      continue
    }
    const r = await tryAttachCommentsToChannelPost(bot, message, {
      botUserId: botUid,
      channelChatIdOverride: reg.chat_id,
      skipAuthorAdminCheck: true,
      source: 'refresh',
    })
    applyRefreshAttachResult(stats, r, true)
    if (!r.ok && r.reason === 'attach_failed') {
      scheduleCommentButtonRetry(reg.chat_id, post.message_mid)
    }
  }

  let messages: Awaited<ReturnType<typeof bot.api.getMessages>>['messages']
  try {
    const result = await apiCallWithRetry(() =>
      bot.api.getMessages(reg.chat_id, { count: REFRESH_BUTTONS_FETCH_COUNT }),
    )
    messages = result.messages
  } catch (err: unknown) {
    logger.warn('channelPoller: runChannelPollerForChat getMessages failed', {
      chatId: reg.chat_id,
      err,
    })
    throw new RefreshButtonsError(
      'api_error',
      'Не удалось получить сообщения канала (проверьте права бота)',
    )
  }

  stats.messages_fetched = messages.length
  for (const message of messages) {
    const mid = message.body?.mid
    if (typeof mid !== 'string' || mid.trim() === '' || processedMids.has(mid)) {
      continue
    }
    const linkedPost = postStore.findPostByCommentsUiMessage(reg.chat_id, mid)
    if (linkedPost) {
      processedMids.add(mid)
      continue
    }
    const wasInDb = postStore.findPostByChannelMessage(reg.chat_id, mid) !== null
    const r = await tryAttachCommentsToChannelPost(bot, message, {
      botUserId: botUid,
      channelChatIdOverride: reg.chat_id,
      skipAuthorAdminCheck: true,
      source: 'refresh',
    })
    applyRefreshAttachResult(stats, r, wasInDb)
    if (!r.ok && r.reason === 'attach_failed' && mid) {
      scheduleCommentButtonRetry(reg.chat_id, mid)
    }
    processedMids.add(mid)
  }

  logger.info('channelPoller: runChannelPollerForChat done', stats)
  return stats
}

/**
 * @deprecated Используется syncPerChannelPollers; оставлено для совместимости вызовов.
 */
export async function runChannelPollerTick(bot: Bot): Promise<void> {
  syncPerChannelPollers(bot)
}

/**
 * Запускает опрос каждого канала по отдельному таймеру + синхронизацию при изменении реестра.
 */
export function startChannelPostPoller(bot: Bot, intervalMs?: number): void {
  if (!isMiniAppOpenUrlConfigured()) {
    logger.info('channelPoller: disabled (BOT_NICKNAME / MINI_APP_URL not set for Mini App links)')
    return
  }

  const fromStoreOrArg =
    intervalMs !== undefined && Number.isFinite(intervalMs)
      ? intervalMs
      : adminRuntimeSettingsStore.getPollIntervalMs()
  perChannelIntervalMs = resolvePerChannelIntervalMs(fromStoreOrArg)

  stopChannelPostPoller()
  syncPerChannelPollers(bot)

  logger.info('channelPoller: started (per-channel)', {
    channelCount: channelRegistry.getAllChannels().filter((c) => c.type === 'channel').length,
    perChannelIntervalMs,
    fetchCount: FETCH_COUNT,
    pollConcurrency: POLL_CONCURRENCY,
  })
}

/**
 * Перезапуск таймеров с разрешением из {@link adminRuntimeSettingsStore}.
 */
export function restartChannelPostPoller(bot: Bot): void {
  startChannelPostPoller(bot)
}

/** Сбрасывает счётчик ошибок поллера для канала (после полного отключения). */
export function clearChannelPollerErrors(chatId: number): void {
  const abs = Math.abs(chatId)
  for (const key of [...errorCount.keys()]) {
    if (Math.abs(key) === abs) {
      errorCount.delete(key)
    }
  }
}

export function stopChannelPostPoller(): void {
  for (const chatId of [...channelTimers.keys()]) {
    stopChannelTimer(chatId)
  }
  botRef = null
  logger.info('channelPoller: stopped')
}

/** Вызвать после добавления/удаления канала в реестре (если поллер уже запущен). */
export function notifyChannelRegistryChanged(): void {
  if (botRef) {
    syncPerChannelPollers(botRef)
  }
}
