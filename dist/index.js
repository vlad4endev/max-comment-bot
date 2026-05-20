"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const bot_1 = require("./bot");
const config_1 = require("./config");
const migrate_1 = require("./db/migrate");
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
const postStore_1 = require("./services/postStore");
const userMiniappSettingsStore_1 = require("./services/userMiniappSettingsStore");
const logger_1 = require("./utils/logger");
const envFile_1 = require("./utils/envFile");
const config_2 = require("./config");
const updateQueue_1 = require("./utils/updateQueue");
const flowProcessor_1 = require("./services/flowProcessor");
const integrationsStore_1 = require("./services/integrationsStore");
const channelImportService_1 = require("./services/channelImportService");
const tgChainForwarder_1 = require("./services/tgChainForwarder");
const createWebhookApp_1 = require("./webhook/createWebhookApp");
async function main() {
    (0, migrate_1.migrateFromJson)();
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
    (0, logger_1.startRuntimeLogRotationScheduler)();
    (0, channelRegistry_1.setChannelRegistryChangeHandler)(() => (0, channelPoller_1.notifyChannelRegistryChanged)());
    (0, channelPoller_1.startChannelPostPoller)(bot);
    (0, commentButtonRetryQueue_1.startCommentButtonRetryLoop)(bot);
    // До HTTP: иначе при EADDRINUSE channelPoller уже в логах, а flowProcessor — нет.
    await flowProcessor_1.flowProcessor.start();
    const channelCount = channelRegistry_1.channelRegistry
        .getAllChannels()
        .filter((c) => c.type === 'channel').length;
    const enabledFlows = integrationsStore_1.integrationsStore.getFlows().filter((f) => f.enabled);
    logger_1.logger.info('🚀 Бот запущен', {
        channelCount,
        pollerConcurrency: channelPoller_1.POLL_CONCURRENCY,
        webhookConcurrency: updateQueue_1.WEBHOOK_CONCURRENCY,
        logRotation: true,
        receiveMode: config_1.config.receiveMode,
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
            logger_1.logger.error('Не удалось зарегистрировать webhook', e);
            server.close();
            process.exit(1);
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