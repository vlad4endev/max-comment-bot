import type { Bot } from '@maxhub/max-bot-api'
import pLimit from 'p-limit'

import { adminRuntimeSettingsStore } from './adminRuntimeSettingsStore'
import { clearAdminJoinNotifiedForChannel } from './channelAdminJoinNotified'
import type { ChannelRecord } from './channelRegistry'
import { channelRegistry } from './channelRegistry'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { logger } from '../utils/logger'
import { apiCallWithRetry } from '../utils/maxApiRetry'
import { tryAttachCommentsToChannelPost } from './channelPostActions'
import { isMiniAppOpenUrlConfigured } from './postStore'

const MIN_POLL_INTERVAL_MS = 3_000
const FETCH_COUNT = 30
/** Admin «обновить кнопки» scans more history than the periodic poller. */
const REFRESH_BUTTONS_FETCH_COUNT = 50
/** Exported for startup diagnostics. */
export const POLL_CONCURRENCY = 5
const DISABLE_AFTER_ERRORS = 5

let intervalId: ReturnType<typeof setInterval> | undefined
let tickInFlight = false
const errorCount = new Map<number, number>()

function logTickFired(): void {
  const channels = channelRegistry.getAllChannels()
  logger.info('channelPoller: tick fired', {
    channelCount: channels.length,
    channels: channels.map((c) => c.chat_id),
  })
}

async function pollChannel(
  bot: Bot,
  channel: ChannelRecord,
  botUid: number | undefined,
): Promise<void> {
  const { messages } = await apiCallWithRetry(() =>
    bot.api.getMessages(channel.chat_id, { count: FETCH_COUNT }),
  )
  logger.info('channelPoller: getMessages result', {
    chatId: channel.chat_id,
    messageCount: messages.length,
    mids: messages.map((m) => m.body?.mid),
  })
  if (messages.length === 0) {
    logger.info('channelPoller: no messages returned for channel', { chatId: channel.chat_id })
  }
  for (const message of messages) {
    await tryAttachCommentsToChannelPost(bot, message, {
      botUserId: botUid,
      channelChatIdOverride: channel.chat_id,
      /** Channel posts often have no admin-shaped sender; poller only runs on registered channels. */
      skipAuthorAdminCheck: true,
      source: 'poller',
    })
  }
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
    }
  }
}

export interface RefreshButtonsStats {
  chat_id: number
  messages_fetched: number
  created: number
  refreshed: number
  skipped: number
  failed: number
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
    created: 0,
    refreshed: 0,
    skipped: 0,
    failed: 0,
  }

  const botUid = bot.botInfo?.user_id
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
    const r = await tryAttachCommentsToChannelPost(bot, message, {
      botUserId: botUid,
      channelChatIdOverride: reg.chat_id,
      skipAuthorAdminCheck: true,
      source: 'refresh',
    })
    if (r.ok) {
      stats.created += 1
    } else if (r.reason === 'already_exists') {
      stats.refreshed += 1
    } else if (
      r.reason === 'skip_bot' ||
      r.reason === 'no_mid' ||
      r.reason === 'no_chat_id' ||
      r.reason === 'not_admin'
    ) {
      stats.skipped += 1
    } else {
      stats.failed += 1
    }
  }

  logger.info('channelPoller: runChannelPollerForChat done', stats)
  return stats
}

/**
 * One sweep: for each registered channel, fetch recent messages and attach the comment button to new admin posts.
 */
export async function runChannelPollerTick(bot: Bot): Promise<void> {
  if (!isMiniAppOpenUrlConfigured()) {
    return
  }

  const channels = channelRegistry.getAllChannels().filter((c) => c.type === 'channel')
  const botUid = bot.botInfo?.user_id
  const limit = pLimit(POLL_CONCURRENCY)

  await Promise.all(channels.map((c) => limit(() => pollChannelSafe(bot, c, botUid))))
}

/**
 * Starts periodic polling of registered channels. No-op if Mini App open URL is not configured.
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
  const ms = Math.max(MIN_POLL_INTERVAL_MS, fromStoreOrArg)

  stopChannelPostPoller()

  const channelCount = channelRegistry
    .getAllChannels()
    .filter((c) => c.type === 'channel').length

  logTickFired()
  void (async () => {
    try {
      await runChannelPollerTick(bot)
    } catch (err: unknown) {
      logger.error('channelPoller: tick error', err)
    }
  })()

  intervalId = setInterval(() => {
    logTickFired()
    if (tickInFlight) {
      logger.info('channelPoller: skipping tick (previous still running)')
      return
    }
    tickInFlight = true
    void (async () => {
      try {
        await runChannelPollerTick(bot)
      } catch (err: unknown) {
        logger.error('channelPoller: tick error', err)
      } finally {
        tickInFlight = false
      }
    })()
  }, ms)

  logger.info('channelPoller: started', {
    channelCount,
    concurrency: POLL_CONCURRENCY,
    intervalMs: ms,
    fetchCount: FETCH_COUNT,
  })
}

/**
 * Перезапуск таймера с разрешением из {@link adminRuntimeSettingsStore}.
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
  if (intervalId !== undefined) {
    clearInterval(intervalId)
    intervalId = undefined
    logger.info('channelPoller: stopped')
  }
}
