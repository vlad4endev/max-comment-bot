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
import { telegramProxyStore } from './services/telegramProxyStore'
import { invalidatePersistentMtprotoClient } from './services/telegramUserArchive'
import {
  applyTelegramProxyRuntime,
  setTelegramProxyChangeHandler,
} from './utils/telegramProxyRuntime'
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
import { ensureAdminPanelStateLoaded, listTgChainsSync, listVkChainsSync } from './api/adminPanelState'
import { repairLegacyMiniappTgChains } from './services/channelLinkService'
import { backfillPostCommentMappingsFromForwarded } from './services/postCommentMappingStore'
import { bootstrapCommentSyncOnStartup } from './services/commentSyncDiagnostics'
import {
  repairStuckTgChainForwardedNullRows,
  repairTgChainsForForwarding,
  repairStaleTgChainBotTokens,
  repairMiniappChainsForwardComments,
  repairTgChainForwardPostsSince,
} from './services/tgChainChannelRef'
import { setTgChainForwarderBot, startTgChainForwarder } from './services/tgChainForwarder'
import { startTelegramAntispamBotPoller } from './services/telegramAntispamBotService'
import { startTgPostDeletionWatcher } from './services/tgPostDeletionWatcher'
import { setVkChainForwarderBot, startVkChainForwarder, stopVkChainForwarder } from './services/vkChainForwarder'
import { setTelegramTgChainLifecycleBot } from './services/telegramTgChainLifecycle'
import { sendAdminAlert, setAdminAlertBot } from './utils/alertService'
import { setTelegramSyncAlertBot } from './services/telegramSyncAlertService'
import {
  assertTelegramBotApiOnStartup,
  startTelegramHealthMonitor,
  stopTelegramHealthMonitor,
} from './services/telegramHealthService'
import { initRedis } from './cache/redisClient'
import { createHttpApp, createWebhookApp } from './webhook/createWebhookApp'
import { logMiniAppUrlDiagnostics } from './utils/telegramMiniAppUrl'

function scheduleDeferredCommentSyncBootstrap(): void {
  void bootstrapCommentSyncOnStartup({ threadRepairLimit: 8 }).catch((err: unknown) => {
    logger.error('[commentSync] deferred bootstrap failed', err)
  })
}

async function logStartupChainsSummary(): Promise<void> {
  const chains = listTgChainsSync()
  const vkChains = listVkChainsSync()
  const issues: string[] = []

  for (const c of chains) {
    if (c.active && c.forward_comments && !c.tg_discussion_chat_id) {
      issues.push(`${c.max_title ?? c.id}: нет tg_discussion_chat_id`)
    }
    if (c.active && c.forward_posts) {
      const since = c.forward_posts_since ? new Date(c.forward_posts_since) : null
      const sinceHoursAgo = since ? (Date.now() - since.getTime()) / 3_600_000 : null
      if (sinceHoursAgo !== null && sinceHoursAgo < 2) {
        issues.push(
          `${c.max_title ?? c.id}: forward_posts_since свежий (${Math.round(sinceHoursAgo * 60)} мин назад)`,
        )
      }
    }
  }

  for (const c of vkChains) {
    if (c.active !== false && c.forward_posts === false) {
      issues.push(`VK ${c.vk_name ?? c.vk_group_id}: forward_posts выключен`)
    }
    if (c.active !== false && !c.vk_token?.trim()) {
      issues.push(`VK ${c.vk_name ?? c.vk_group_id}: пустой vk_token`)
    }
  }

  logger.info('[startup] chains summary', {
    chains: chains.map((c) => ({
      title: c.max_title,
      active: c.active,
      forward_posts: c.forward_posts,
      forward_comments: c.forward_comments,
      discussion: c.tg_discussion_chat_id ? 'ok' : 'MISSING',
      since: c.forward_posts_since?.slice(0, 16),
    })),
    vk_chains: vkChains.map((c) => ({
      title: c.vk_name ?? c.vk_group_id,
      max_chat_id: c.max_chat_id,
      active: c.active,
      forward_posts: c.forward_posts !== false,
      sync_comments: c.sync_comments,
      has_token: Boolean(c.vk_token?.trim()),
    })),
    issues,
  })

  if (issues.length > 0) {
    await sendAdminAlert('startup_issues', `Обнаружены проблемы при старте (${issues.length})`, {
      issues,
    })
  }
}

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
  await telegramProxyStore.loadFromDisk()
  setTelegramProxyChangeHandler(() => {
    invalidatePersistentMtprotoClient()
  })
  await applyTelegramProxyRuntime()
  await integrationsStore.load()
  await ensureAdminPanelStateLoaded()
  await repairLegacyMiniappTgChains()
  const forwardCommentsRepaired = await repairMiniappChainsForwardComments()
  if (forwardCommentsRepaired > 0) {
    logger.warn('Включена синхронизация комментариев для miniapp-цепочек', {
      chains: forwardCommentsRepaired,
    })
  }
  await repairTgChainsForForwarding()
  const stuckForwardedCleared = repairStuckTgChainForwardedNullRows()
  if (stuckForwardedCleared > 0) {
    logger.warn('Очищены застрявшие TG-посты без max_message_mid — пересылка будет повторена', {
      rows: stuckForwardedCleared,
    })
  }
  const forwardSinceRepaired = await repairTgChainForwardPostsSince()
  if (forwardSinceRepaired > 0) {
    logger.info('Задана дата forward_posts_since для TG-связок', { chains: forwardSinceRepaired })
  }
  const staleChainTokens = await repairStaleTgChainBotTokens()
  if (staleChainTokens.repaired > 0) {
    logger.warn('Заменены устаревшие bot_token в TG-цепочках', staleChainTokens)
  }
  const mappingsBackfilled = backfillPostCommentMappingsFromForwarded()
  if (mappingsBackfilled > 0) {
    logger.info('[commentSync] backfilled post_comment_mapping on startup', { mappingsBackfilled })
  }
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
  startTgPostDeletionWatcher(bot)
  setVkChainForwarderBot(bot)
  setTelegramTgChainLifecycleBot(bot)
  setAdminAlertBot(bot)
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

  // HTTP сразу после базовой инициализации — /health не должен ждать purge/sync/alerts.
  let httpServer: ReturnType<typeof createServer>
  if (config.receiveMode === 'webhook') {
    const webhookPath = config.webhookPath!
    const webhookUrl = config.webhookUrl!

    const app = createWebhookApp({
      bot,
      webhookPath,
      webhookSecret: config.webhookSecret,
    })

    httpServer = createServer(app)

    await new Promise<void>((resolve, reject) => {
      httpServer.listen(listenPort, '0.0.0.0', () => resolve())
      httpServer.once('error', reject)
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
      void sendAdminAlert(
        'max_webhook_failed',
        'Не удалось зарегистрировать webhook MAX — события канала (посты/комментарии) могут не приходить',
        { error: e instanceof Error ? e.message : String(e) },
      )
    }

    setupGracefulShutdown(bot, {
      receiveMode: 'webhook',
      httpServer,
      webhookUrl,
    })
  } else {
    const app = createHttpApp({ bot })
    httpServer = createServer(app)

    await new Promise<void>((resolve, reject) => {
      httpServer.listen(listenPort, '0.0.0.0', () => resolve())
      httpServer.once('error', reject)
    })

    logger.info(
      `HTTP слушает 0.0.0.0:${listenPort} (/api, /miniapp); long polling для updates`,
    )

    setupGracefulShutdown(bot, {
      receiveMode: 'polling',
      httpServer,
    })
  }

  // Диагностика цепочек и тяжёлая синхронизация — после listen.
  void logStartupChainsSummary().catch((err: unknown) => {
    logger.warn('[startup] chains summary failed', { err })
  })

  const { startMaxCommentSync } = await import('./services/maxCommentSyncService')
  const stopCommentSync = startMaxCommentSync(bot)
  process.once('SIGINT', () => stopCommentSync())
  process.once('SIGTERM', () => stopCommentSync())

  startVkChainForwarder()
  process.once('SIGINT', () => stopVkChainForwarder())
  process.once('SIGTERM', () => stopVkChainForwarder())

  startChannelImportWorker()
  startTgChainForwarder()
  const stopAntispamBot = startTelegramAntispamBotPoller()
  process.once('SIGINT', () => stopAntispamBot())
  process.once('SIGTERM', () => stopAntispamBot())
  scheduleDeferredCommentSyncBootstrap()

  if (config.receiveMode !== 'webhook') {
    await startBotLongPolling(bot)
  }
}

main().catch((err: unknown) => {
  console.error(err)
  void sendAdminAlert('process_crash', 'Процесс бота упал — перенос постов и комментариев остановлен', {
    error: err instanceof Error ? err.message : String(err),
  }).finally(() => {
    process.exit(1)
  })
})

process.on('uncaughtException', (err: unknown) => {
  logger.error('uncaughtException', err)
  void sendAdminAlert(
    'uncaught_exception',
    'Критический сбой процесса — перенос постов и комментариев остановлен',
    { error: err instanceof Error ? err.message : String(err) },
  ).finally(() => {
    process.exit(1)
  })
})
