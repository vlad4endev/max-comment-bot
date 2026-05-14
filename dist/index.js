"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
const bot_1 = require("./bot");
const config_1 = require("./config");
const subscriptions_1 = require("./maxPlatform/subscriptions");
const channelRegistry_1 = require("./services/channelRegistry");
const logger_1 = require("./utils/logger");
const createWebhookApp_1 = require("./webhook/createWebhookApp");
async function main() {
    const bot = (0, bot_1.initializeBot)();
    await channelRegistry_1.channelRegistry.loadFromDisk();
    await (0, bot_1.ensureBotProfile)(bot);
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
            server.listen(config_1.config.PORT, '0.0.0.0', () => resolve());
            server.once('error', reject);
        });
        logger_1.logger.info(`HTTP слушает 0.0.0.0:${config_1.config.PORT}, endpoint webhook: POST ${webhookPath}`);
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
    }
    else {
        (0, bot_1.setupGracefulShutdown)(bot, { receiveMode: 'polling' });
        await (0, bot_1.startBotLongPolling)(bot);
    }
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map