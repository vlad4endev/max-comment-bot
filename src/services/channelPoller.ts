import type { Bot } from '@maxhub/max-bot-api'
import pLimit from 'p-limit'

import { adminRuntimeSettingsStore } from './adminRuntimeSettingsStore'
import { clearAdminJoinNotifiedForChannel } from './channelAdminJoinNotified'
import type { ChannelRecord } from './channelRegistry'
import { channelRegistry } from './channelRegistry'
import { logger } from '../utils/logger'
import { apiCallWithRetry } from '../utils/maxApiRetry'
import { tryAttachCommentsToChannelPost } from './channelPostActions'
import { isMiniAppOpenUrlConfigured } from './postStore'

const MIN_POLL_INTERVAL_MS = 3_000
const FETCH_COUNT = 10
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
    const r = await tryAttachCommentsToChannelPost(bot, message, {
      botUserId: botUid,
      channelChatIdOverride: channel.chat_id,
    })
    const logPayload = {
      chatId: channel.chat_id,
      mid: message.body?.mid,
      result: r,
    }
    if (!r.ok && r.reason === 'already_exists') {
      logger.debug('channelPoller: tryAttach result', logPayload)
    } else {
      logger.info('channelPoller: tryAttach result', logPayload)
    }
    if (r.ok) {
      logger.info('channelPoller: button attached to new post', {
        channelChatId: channel.chat_id,
        mid: message.body.mid,
      })
    }
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

/**
 * One sweep for a single channel (admin «обновить кнопки»).
 */
export async function runChannelPollerForChat(bot: Bot, chatId: number): Promise<void> {
  if (!isMiniAppOpenUrlConfigured()) {
    return
  }

  const reg = channelRegistry.getChannel(chatId)
  if (!reg || reg.type !== 'channel') {
    return
  }

  const botUid = bot.botInfo?.user_id
  try {
    const { messages } = await apiCallWithRetry(() =>
      bot.api.getMessages(chatId, { count: FETCH_COUNT }),
    )
    for (const message of messages) {
      await tryAttachCommentsToChannelPost(bot, message, {
        botUserId: botUid,
        channelChatIdOverride: chatId,
      })
    }
  } catch (err: unknown) {
    logger.warn('channelPoller: runChannelPollerForChat failed', { chatId, err })
  }
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
