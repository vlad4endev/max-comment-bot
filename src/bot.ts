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
import { flowProcessor } from './services/flowProcessor'
import { stateManager } from './services/stateManager'
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

async function startBotLongPolling(bot: Bot): Promise<void> {
  logger.info('🚀 Запуск бота (long polling, GET /updates)...')
  try {
    const allowedUpdates = [...BOT_WEBHOOK_UPDATE_TYPES] as UpdateType[]
    await bot.start({ allowedUpdates })
    logger.info('🤖 Бот работает и ждёт события')
  } catch (error) {
    logger.error('Ошибка при запуске long polling', error)
    throw error
  }
}

export interface GracefulShutdownOptions {
  receiveMode: 'webhook' | 'polling'
  httpServer?: Server
  webhookUrl?: string
}

function setupGracefulShutdown(bot: Bot, options: GracefulShutdownOptions): void {
  const onSignal = () => {
    void (async () => {
      logger.info('👋 Получен сигнал выключения...')
      stopChannelPostPoller()
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
