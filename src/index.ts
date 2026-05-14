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
import { commentStore } from './services/commentStore'
import { startChannelPostPoller } from './services/channelPoller'
import { postStore } from './services/postStore'
import { logger } from './utils/logger'
import { createHttpApp, createWebhookApp } from './webhook/createWebhookApp'

async function main(): Promise<void> {
  const bot = initializeBot()
  await channelRegistry.loadFromDisk()
  await postStore.loadFromDisk()
  await commentStore.loadFromDisk()
  await ensureBotProfile(bot)
  startChannelPostPoller(bot)

  const listenPort = config.listenPort

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
      server.listen(listenPort, '0.0.0.0', () => resolve())
      server.once('error', reject)
    })

    logger.info(
      `HTTP слушает 0.0.0.0:${listenPort}, webhook: POST ${webhookPath}, /api, /miniapp`,
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
    const app = createHttpApp({ bot })
    const server = createServer(app)

    await new Promise<void>((resolve, reject) => {
      server.listen(listenPort, '0.0.0.0', () => resolve())
      server.once('error', reject)
    })

    logger.info(
      `HTTP слушает 0.0.0.0:${listenPort} (/api, /miniapp); long polling для updates`,
    )

    setupGracefulShutdown(bot, {
      receiveMode: 'polling',
      httpServer: server,
    })

    await startBotLongPolling(bot)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
