import { Bot } from '@maxhub/max-bot-api'

import { config } from './config'
import { registerEventHandlers } from './handlers/events'
import { logger } from './utils/logger'

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

async function startBot(bot: Bot): Promise<void> {
  logger.info('🚀 Запуск бота...')
  try {
    await bot.start()
    logger.info('🤖 Бот запущен и ждёт событий')
    logger.info('📡 Webhook подписан автоматически MAX Bot API')
  } catch (error) {
    logger.error('Ошибка при запуске', error)
    throw error
  }
}

function setupGracefulShutdown(bot: Bot): void {
  const onSignal = () => {
    logger.info('👋 Получен сигнал выключения...')
    bot.stop()
    logger.info('🛑 Бот остановлен')
    process.exit(0)
  }

  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
}

export { initializeBot, startBot, setupGracefulShutdown }
