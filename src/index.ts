import { createServer } from 'node:http'

import {
  ensureBotProfile,
  initializeBot,
  setupGracefulShutdown,
  startBotLongPolling,
} from './bot'
import { config } from './config'
import { migrateFromJson } from './db/migrate'
import { migrateAutopostsFromJson } from './db/migrateAutopostsFromJson'
import { migrateAutopostsFromBotDb } from './db/migratePostsDb'
import { migrateAntispamFromJson } from './db/migrateAntispamDb'
import { seedAntispamScoredWordsIfEmpty } from './db/seedAntispamScoredWords'
import {
  BOT_WEBHOOK_UPDATE_TYPES,
  setWebhookSubscription,
} from './maxPlatform/subscriptions'
import { channelNotifyLinkStore } from './services/channelNotifyLinkStore'
import { channelRegistry, setChannelRegistryChangeHandler } from './services/channelRegistry'
import { channelSettingsStore } from './services/channelSettingsStore'
import { commentStore } from './services/commentStore'
import { adminRuntimeSettingsStore } from './services/adminRuntimeSettingsStore'
import { logAiSettingsStore } from './services/logAiSettingsStore'
import { disabledAdminStore } from './services/disabledAdminStore'
import { subscriberStore } from './services/subscriberStore'
import {
  notifyChannelRegistryChanged,
  POLL_CONCURRENCY,
  startChannelPostPoller,
} from './services/channelPoller'
import { startCommentButtonRetryLoop } from './services/commentButtonRetryQueue'
import { startPostLinkAutoRecovery } from './services/postLinkAutoRecovery'
import { postStore } from './services/postStore'
import { userMiniappSettingsStore } from './services/userMiniappSettingsStore'
import { logger, startRuntimeLogRotationScheduler } from './utils/logger'
import { upsertRootEnvVar } from './utils/envFile'
import { getFlowPollIntervalMs, getTelegramToken } from './config'
import { WEBHOOK_CONCURRENCY } from './utils/updateQueue'
import { flowProcessor } from './services/flowProcessor'
import { integrationsStore } from './services/integrationsStore'
import { startAutopostScheduler } from './services/autopostScheduler'
import { startChannelImportWorker } from './services/channelImportService'
import { ensureAdminPanelStateLoaded } from './api/adminPanelState'
import { repairLegacyMiniappTgChains } from './services/channelLinkService'
import { repairTgChainsForForwarding } from './services/tgChainChannelRef'
import { setTgChainForwarderBot, startTgChainForwarder } from './services/tgChainForwarder'
import { setVkChainForwarderBot, startVkChainForwarder, stopVkChainForwarder } from './services/vkChainForwarder'
import { setTelegramTgChainLifecycleBot } from './services/telegramTgChainLifecycle'
import { setTelegramSyncAlertBot } from './services/telegramSyncAlertService'
import {
  assertTelegramBotApiOnStartup,
  startTelegramHealthMonitor,
  stopTelegramHealthMonitor,
} from './services/telegramHealthService'
import { initRedis } from './cache/redisClient'
import { createHttpApp, createWebhookApp } from './webhook/createWebhookApp'
import { logMiniAppUrlDiagnostics } from './utils/telegramMiniAppUrl'

async function main(): Promise<void> {
  migrateFromJson()
  migrateAutopostsFromBotDb()
  migrateAutopostsFromJson()
  await migrateAntispamFromJson()
  seedAntispamScoredWordsIfEmpty()
  const redisStatus = await initRedis()
  const bot = initializeBot()
  await channelRegistry.loadFromDisk()
  await channelSettingsStore.loadFromDisk()
  await postStore.loadFromDisk()
  await commentStore.loadFromDisk()
  await userMiniappSettingsStore.loadFromDisk()
  await channelNotifyLinkStore.loadFromDisk()
  await subscriberStore.loadFromDisk()
  await adminRuntimeSettingsStore.loadFromDisk()
  await disabledAdminStore.loadFromDisk()
  await logAiSettingsStore.loadFromDisk()
  await integrationsStore.load()
  await ensureAdminPanelStateLoaded()
  await repairLegacyMiniappTgChains()
  await repairTgChainsForForwarding()
  try {
    await ensureBotProfile(bot)
  } catch (err: unknown) {
    logger.error(
      'MAX API недоступен (ensureBotProfile) — HTTP и автопостинг всё равно запускаются; проверьте BOT_TOKEN',
      err,
    )
  }
  const tgIntegration = integrationsStore
    .getIntegrations()
    .find((i) => i.platform === 'telegram' && i.status === 'connected')
  if (tgIntegration?.token) {
    const envToken = getTelegramToken()
    if (envToken !== tgIntegration.token.trim()) {
      process.env.TG_TOKEN = tgIntegration.token.trim()
      try {
        await upsertRootEnvVar('TG_TOKEN', tgIntegration.token.trim())
      } catch (err: unknown) {
        logger.warn('Не удалось синхронизировать TG_TOKEN из integrations.json в .env', err)
      }
    }
  }
  flowProcessor.setBot(bot)
  setTgChainForwarderBot(bot)
  setVkChainForwarderBot(bot)
  setTelegramTgChainLifecycleBot(bot)
  setTelegramSyncAlertBot(bot)
  await assertTelegramBotApiOnStartup()
  startTelegramHealthMonitor()
  process.once('SIGINT', () => stopTelegramHealthMonitor())
  process.once('SIGTERM', () => stopTelegramHealthMonitor())
  startRuntimeLogRotationScheduler()
  setChannelRegistryChangeHandler(() => notifyChannelRegistryChanged())
  startChannelPostPoller(bot)
  startCommentButtonRetryLoop(bot)
  startPostLinkAutoRecovery(bot)
  startAutopostScheduler()
  // До HTTP: иначе при EADDRINUSE channelPoller уже в логах, а flowProcessor — нет.
  await flowProcessor.start()

  // Синхронизация комментариев TG ↔ Max
  const { startMaxCommentSync } = await import('./services/maxCommentSyncService')
  const stopCommentSync = startMaxCommentSync(bot)
  process.once('SIGINT', () => stopCommentSync())
  process.once('SIGTERM', () => stopCommentSync())

  startVkChainForwarder()
  process.once('SIGINT', () => stopVkChainForwarder())
  process.once('SIGTERM', () => stopVkChainForwarder())

  const channelCount = channelRegistry
    .getAllChannels()
    .filter((c) => c.type === 'channel').length
  const enabledFlows = integrationsStore.getFlows().filter((f) => f.enabled)
  logMiniAppUrlDiagnostics(config.miniAppUrl, config.botNickname)

  logger.info('🚀 Бот запущен', {
    channelCount,
    pollerConcurrency: POLL_CONCURRENCY,
    webhookConcurrency: WEBHOOK_CONCURRENCY,
    logRotation: true,
    receiveMode: config.receiveMode,
    redis: redisStatus,
    telegramConnected: !!tgIntegration,
    flowProcessorEnabledFlows: enabledFlows.length,
    flowPollIntervalMs: getFlowPollIntervalMs(),
    flows: enabledFlows.map((f) => ({
      id: f.id,
      from: `${f.source.platform}:${f.source.channelUsername ?? f.source.channelId ?? '?'}`,
      to: `${f.destination.platform}:${f.destination.channelId}`,
    })),
  })

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
      logger.error(
        'Не удалось зарегистрировать webhook — HTTP (/miniapp, /api) остаётся доступен; проверьте WEBHOOK_URL и доступ к API MAX',
        e,
      )
    }

    setupGracefulShutdown(bot, {
      receiveMode: 'webhook',
      httpServer: server,
      webhookUrl,
    })
    startChannelImportWorker()
    startTgChainForwarder()
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

    startChannelImportWorker()
    startTgChainForwarder()
    await startBotLongPolling(bot)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
