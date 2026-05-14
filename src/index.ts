import { createServer } from 'node:http'

import {
  ensureBotProfile,
  initializeBot,
  setupGracefulShutdown,
  startBotLongPolling,
} from './bot'
import { config } from './config'
import {
  BOT_WEBHOOK_UPDATE_TYPES,
  setWebhookSubscription,
} from './maxPlatform/subscriptions'
import { channelRegistry } from './services/channelRegistry'
import { logger } from './utils/logger'
import { createWebhookApp } from './webhook/createWebhookApp'

async function main(): Promise<void> {
  const bot = initializeBot()
  await channelRegistry.loadFromDisk()
  await ensureBotProfile(bot)

  if (config.receiveMode === 'webhook') {
    const webhookPath = config.webhookPath!
    const webhookUrl = config.webhookUrl!

    const app = createWebhookApp({
      bot,
      webhookPath,
      webhookSecret: config.webhookSecret,
    })

    const server = createServer(app)

    await new Promise<void>((resolve, reject) => {
      server.listen(config.PORT, '0.0.0.0', () => resolve())
      server.once('error', reject)
    })

    logger.info(
      `HTTP слушает 0.0.0.0:${config.PORT}, endpoint webhook: POST ${webhookPath}`,
    )

    try {
      await setWebhookSubscription({
        token: config.BOT_TOKEN,
        url: webhookUrl,
        secret: config.webhookSecret,
        updateTypes: BOT_WEBHOOK_UPDATE_TYPES,
      })
      logger.info('Подписка webhook активна (POST /subscriptions)')
    } catch (e) {
      logger.error('Не удалось зарегистрировать webhook', e)
      server.close()
      process.exit(1)
    }

    setupGracefulShutdown(bot, {
      receiveMode: 'webhook',
      httpServer: server,
      webhookUrl,
    })
  } else {
    setupGracefulShutdown(bot, { receiveMode: 'polling' })
    await startBotLongPolling(bot)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
