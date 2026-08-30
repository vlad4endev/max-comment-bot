import type { Server } from 'node:http'

import { Bot } from '@maxhub/max-bot-api'
import type { UpdateType } from '@maxhub/max-bot-api/types'

import { config } from './config'
import { registerEventHandlers } from './handlers/events'
import {
  BOT_WEBHOOK_UPDATE_TYPES,
  deleteWebhookSubscription,
} from './maxPlatform/subscriptions'
import { stopChannelPostPoller } from './services/channelPoller'
import { stopCommentButtonRetryLoop } from './services/commentButtonRetryQueue'
import { stopPostLinkAutoRecovery } from './services/postLinkAutoRecovery'
import { stopAutopostScheduler } from './services/autopostScheduler'
import { stopMainVlessTunnel } from './services/telegramProxyTunnel'
import { flowProcessor } from './services/flowProcessor'
import { stateManager } from './services/stateManager'
import { disconnectRedis } from './cache/redisClient'
import { logger, stopRuntimeLogRotationScheduler } from './utils/logger'

function initializeBot(): Bot {
  logger.info('🤖 Инициализация бота...')
  try {
    const bot = new Bot(config.BOT_TOKEN)
    registerEventHandlers(bot)
    logger.info('✅ Бот инициализирован')
    return bot
  } catch (error) {
    logger.error('Ошибка инициализации бота', error)
    throw error
  }
}

async function ensureBotProfile(bot: Bot): Promise<void> {
  bot.botInfo = await bot.api.getMyInfo()
}

let allowMaxPollingRestart = true

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function startBotLongPolling(bot: Bot): Promise<void> {
  const allowedUpdates = [...BOT_WEBHOOK_UPDATE_TYPES] as UpdateType[]
  logger.info('🚀 Запуск бота (long polling, GET /updates)...')
  for (let attempt = 0; allowMaxPollingRestart; attempt += 1) {
    try {
      await bot.start({ allowedUpdates })
      if (!allowMaxPollingRestart) {
        return
      }
      logger.warn('MAX long polling stopped unexpectedly, restarting')
    } catch (error) {
      logger.error('Ошибка long polling MAX', error)
      if (!allowMaxPollingRestart) {
        return
      }
    }
    const waitMs = Math.min(15_000, 2_000 * 2 ** Math.min(attempt, 3))
    await sleep(waitMs)
  }
}

export interface GracefulShutdownOptions {
  receiveMode: 'webhook' | 'polling'
  httpServer?: Server
  webhookUrl?: string
}

function setupGracefulShutdown(bot: Bot, options: GracefulShutdownOptions): void {
  const onSignal = () => {
    allowMaxPollingRestart = false
    void (async () => {
      logger.info('👋 Получен сигнал выключения...')
      stopChannelPostPoller()
      stopCommentButtonRetryLoop()
      stopPostLinkAutoRecovery()
      stopAutopostScheduler()
      void stopMainVlessTunnel()
      flowProcessor.stop()
      stopRuntimeLogRotationScheduler()
      stateManager.destroy()
      if (options.receiveMode === 'polling') {
        bot.stop()
      }
      if (options.webhookUrl) {
        try {
          await deleteWebhookSubscription(config.BOT_TOKEN, options.webhookUrl)
          logger.info('Webhook отписан (DELETE /subscriptions)')
        } catch (e) {
          logger.error('Не удалось вызвать DELETE /subscriptions при остановке', e)
        }
      }
      if (options.httpServer) {
        await new Promise<void>((resolve) => {
          options.httpServer!.close(() => resolve())
        })
      }
      await disconnectRedis()
      logger.info('🛑 Остановка завершена')
      process.exit(0)
    })()
  }

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
}

export {
  initializeBot,
  ensureBotProfile,
  startBotLongPolling,
  setupGracefulShutdown,
}
