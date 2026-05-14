import type { Bot } from '@maxhub/max-bot-api'

import { config } from '../config'
import { logger } from '../utils/logger'
import { tryAttachCommentsToChannelPost } from './channelPostActions'
import { channelRegistry } from './channelRegistry'

const DEFAULT_INTERVAL_MS = 30_000
const FETCH_COUNT = 10

let intervalId: ReturnType<typeof setInterval> | undefined
let tickInFlight = false

function logTickFired(): void {
  const channels = channelRegistry.getAllChannels()
  logger.info('channelPoller: tick fired', {
    channelCount: channels.length,
    channels: channels.map((c) => c.chat_id),
  })
}

/**
 * One sweep: for each registered channel, fetch recent messages and attach the comment button to new admin posts.
 */
export async function runChannelPollerTick(bot: Bot): Promise<void> {
  if (!config.miniAppUrl) {
    return
  }

  const channels = channelRegistry.getAllChannels().filter((c) => c.type === 'channel')
  const botUid = bot.botInfo?.user_id

  for (const c of channels) {
    try {
      const { messages } = await bot.api.getMessages(c.chat_id, { count: FETCH_COUNT })
      logger.info('channelPoller: getMessages result', {
        chatId: c.chat_id,
        messageCount: messages.length,
        mids: messages.map((m) => m.body?.mid),
      })
      if (messages.length === 0) {
        logger.info('channelPoller: no messages returned for channel', { chatId: c.chat_id })
      }
      for (const message of messages) {
        const r = await tryAttachCommentsToChannelPost(bot, message, {
          botUserId: botUid,
          channelChatIdOverride: c.chat_id,
        })
        logger.info('channelPoller: tryAttach result', {
          chatId: c.chat_id,
          mid: message.body?.mid,
          result: r,
        })
        if (r.ok) {
          logger.info('channelPoller: button attached to new post', {
            channelChatId: c.chat_id,
            mid: message.body.mid,
          })
        }
      }
    } catch (err: unknown) {
      logger.warn('channelPoller: failed for channel', { chatId: c.chat_id, err })
    }
  }
}

/**
 * Starts periodic polling of registered channels. No-op if {@link config.miniAppUrl} is unset.
 */
export function startChannelPostPoller(bot: Bot, intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (!config.miniAppUrl) {
    logger.info('channelPoller: disabled (MINI_APP_URL not set)')
    return
  }

  stopChannelPostPoller()

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
  }, intervalMs)

  logger.info(`channelPoller: started (interval ${intervalMs / 1000}s, count=${FETCH_COUNT})`)
}

export function stopChannelPostPoller(): void {
  if (intervalId !== undefined) {
    clearInterval(intervalId)
    intervalId = undefined
    logger.info('channelPoller: stopped')
  }
}
