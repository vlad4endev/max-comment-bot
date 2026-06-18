"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const bot_1 = require("./bot");
const config_1 = require("./config");
const migrate_1 = require("./db/migrate");
const migrateAutopostsFromJson_1 = require("./db/migrateAutopostsFromJson");
const subscriptions_1 = require("./maxPlatform/subscriptions");
const channelNotifyLinkStore_1 = require("./services/channelNotifyLinkStore");
const channelRegistry_1 = require("./services/channelRegistry");
const channelSettingsStore_1 = require("./services/channelSettingsStore");
const commentStore_1 = require("./services/commentStore");
const adminRuntimeSettingsStore_1 = require("./services/adminRuntimeSettingsStore");
const disabledAdminStore_1 = require("./services/disabledAdminStore");
const subscriberStore_1 = require("./services/subscriberStore");
const channelPoller_1 = require("./services/channelPoller");
const commentButtonRetryQueue_1 = require("./services/commentButtonRetryQueue");
const postLinkAutoRecovery_1 = require("./services/postLinkAutoRecovery");
const postStore_1 = require("./services/postStore");
const userMiniappSettingsStore_1 = require("./services/userMiniappSettingsStore");
const logger_1 = require("./utils/logger");
const envFile_1 = require("./utils/envFile");
const config_2 = require("./config");
const updateQueue_1 = require("./utils/updateQueue");
const flowProcessor_1 = require("./services/flowProcessor");
const integrationsStore_1 = require("./services/integrationsStore");
const autopostScheduler_1 = require("./services/autopostScheduler");
const channelImportService_1 = require("./services/channelImportService");
const adminPanelState_1 = require("./api/adminPanelState");
const channelLinkService_1 = require("./services/channelLinkService");
const tgChainChannelRef_1 = require("./services/tgChainChannelRef");
const tgChainForwarder_1 = require("./services/tgChainForwarder");
const telegramTgChainLifecycle_1 = require("./services/telegramTgChainLifecycle");
const redisClient_1 = require("./cache/redisClient");
const createWebhookApp_1 = require("./webhook/createWebhookApp");
const telegramMiniAppUrl_1 = require("./utils/telegramMiniAppUrl");
async function main() {
    (0, migrate_1.migrateFromJson)();
    (0, migrateAutopostsFromJson_1.migrateAutopostsFromJson)();
    const redisStatus = await (0, redisClient_1.initRedis)();
    const bot = (0, bot_1.initializeBot)();
    await channelRegistry_1.channelRegistry.loadFromDisk();
    await channelSettingsStore_1.channelSettingsStore.loadFromDisk();
    await postStore_1.postStore.loadFromDisk();
    await commentStore_1.commentStore.loadFromDisk();
    await userMiniappSettingsStore_1.userMiniappSettingsStore.loadFromDisk();
    await channelNotifyLinkStore_1.channelNotifyLinkStore.loadFromDisk();
    await subscriberStore_1.subscriberStore.loadFromDisk();
    await adminRuntimeSettingsStore_1.adminRuntimeSettingsStore.loadFromDisk();
    await disabledAdminStore_1.disabledAdminStore.loadFromDisk();
    await (0, bot_1.ensureBotProfile)(bot);
    await integrationsStore_1.integrationsStore.load();
    await (0, adminPanelState_1.ensureAdminPanelStateLoaded)();
    await (0, channelLinkService_1.repairLegacyMiniappTgChains)();
    await (0, tgChainChannelRef_1.repairTgChainsForForwarding)();
    const tgIntegration = integrationsStore_1.integrationsStore
        .getIntegrations()
        .find((i) => i.platform === 'telegram' && i.status === 'connected');
    if (tgIntegration?.token) {
        const envToken = (0, config_2.getTelegramToken)();
        if (envToken !== tgIntegration.token.trim()) {
            process.env.TG_TOKEN = tgIntegration.token.trim();
            try {
                await (0, envFile_1.upsertRootEnvVar)('TG_TOKEN', tgIntegration.token.trim());
            }
            catch (err) {
                logger_1.logger.warn('Не удалось синхронизировать TG_TOKEN из integrations.json в .env', err);
            }
        }
    }
    flowProcessor_1.flowProcessor.setBot(bot);
    (0, tgChainForwarder_1.setTgChainForwarderBot)(bot);
    (0, telegramTgChainLifecycle_1.setTelegramTgChainLifecycleBot)(bot);
    (0, logger_1.startRuntimeLogRotationScheduler)();
    (0, channelRegistry_1.setChannelRegistryChangeHandler)(() => (0, channelPoller_1.notifyChannelRegistryChanged)());
    (0, channelPoller_1.startChannelPostPoller)(bot);
    (0, commentButtonRetryQueue_1.startCommentButtonRetryLoop)(bot);
    (0, postLinkAutoRecovery_1.startPostLinkAutoRecovery)(bot);
    (0, autopostScheduler_1.startAutopostScheduler)();
    // До HTTP: иначе при EADDRINUSE channelPoller уже в логах, а flowProcessor — нет.
    await flowProcessor_1.flowProcessor.start();
    // Синхронизация комментариев TG ↔ Max — добавлено
    const { startMaxCommentSync } = await Promise.resolve().then(() => __importStar(require('./services/maxCommentSyncService')));
    const stopCommentSync = startMaxCommentSync(bot, { intervalMs: 15_000 });
    process.once('SIGINT', () => stopCommentSync());
    process.once('SIGTERM', () => stopCommentSync());
    const channelCount = channelRegistry_1.channelRegistry
        .getAllChannels()
        .filter((c) => c.type === 'channel').length;
    const enabledFlows = integrationsStore_1.integrationsStore.getFlows().filter((f) => f.enabled);
    (0, telegramMiniAppUrl_1.logMiniAppUrlDiagnostics)(config_1.config.miniAppUrl, config_1.config.botNickname);
    logger_1.logger.info('🚀 Бот запущен', {
        channelCount,
        pollerConcurrency: channelPoller_1.POLL_CONCURRENCY,
        webhookConcurrency: updateQueue_1.WEBHOOK_CONCURRENCY,
        logRotation: true,
        receiveMode: config_1.config.receiveMode,
        redis: redisStatus,
        telegramConnected: !!tgIntegration,
        flowProcessorEnabledFlows: enabledFlows.length,
        flowPollIntervalMs: (0, config_2.getFlowPollIntervalMs)(),
        flows: enabledFlows.map((f) => ({
            id: f.id,
            from: `${f.source.platform}:${f.source.channelUsername ?? f.source.channelId ?? '?'}`,
            to: `${f.destination.platform}:${f.destination.channelId}`,
        })),
    });
    const listenPort = config_1.config.listenPort;
    if (config_1.config.receiveMode === 'webhook') {
        const webhookPath = config_1.config.webhookPath;
        const webhookUrl = config_1.config.webhookUrl;
        const app = (0, createWebhookApp_1.createWebhookApp)({
            bot,
            webhookPath,
            webhookSecret: config_1.config.webhookSecret,
        });
        const server = (0, node_http_1.createServer)(app);
        await new Promise((resolve, reject) => {
            server.listen(listenPort, '0.0.0.0', () => resolve());
            server.once('error', reject);
        });
        logger_1.logger.info(`HTTP слушает 0.0.0.0:${listenPort}, webhook: POST ${webhookPath}, /api, /miniapp`);
        try {
            await (0, subscriptions_1.setWebhookSubscription)({
                token: config_1.config.BOT_TOKEN,
                url: webhookUrl,
                secret: config_1.config.webhookSecret,
                updateTypes: subscriptions_1.BOT_WEBHOOK_UPDATE_TYPES,
            });
            logger_1.logger.info('Подписка webhook активна (POST /subscriptions)');
        }
        catch (e) {
            logger_1.logger.error('Не удалось зарегистрировать webhook — HTTP (/miniapp, /api) остаётся доступен; проверьте WEBHOOK_URL и доступ к API MAX', e);
        }
        (0, bot_1.setupGracefulShutdown)(bot, {
            receiveMode: 'webhook',
            httpServer: server,
            webhookUrl,
        });
        (0, channelImportService_1.startChannelImportWorker)();
        (0, tgChainForwarder_1.startTgChainForwarder)();
    }
    else {
        const app = (0, createWebhookApp_1.createHttpApp)({ bot });
        const server = (0, node_http_1.createServer)(app);
        await new Promise((resolve, reject) => {
            server.listen(listenPort, '0.0.0.0', () => resolve());
            server.once('error', reject);
        });
        logger_1.logger.info(`HTTP слушает 0.0.0.0:${listenPort} (/api, /miniapp); long polling для updates`);
        (0, bot_1.setupGracefulShutdown)(bot, {
            receiveMode: 'polling',
            httpServer: server,
        });
        (0, channelImportService_1.startChannelImportWorker)();
        (0, tgChainForwarder_1.startTgChainForwarder)();
        await (0, bot_1.startBotLongPolling)(bot);
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map