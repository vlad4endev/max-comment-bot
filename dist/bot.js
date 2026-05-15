"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeBot = initializeBot;
exports.ensureBotProfile = ensureBotProfile;
exports.startBotLongPolling = startBotLongPolling;
exports.setupGracefulShutdown = setupGracefulShutdown;
const max_bot_api_1 = require("@maxhub/max-bot-api");
const config_1 = require("./config");
const events_1 = require("./handlers/events");
const subscriptions_1 = require("./maxPlatform/subscriptions");
const channelPoller_1 = require("./services/channelPoller");
const logger_1 = require("./utils/logger");
function initializeBot() {
    logger_1.logger.info('🤖 Инициализация бота...');
    try {
        const bot = new max_bot_api_1.Bot(config_1.config.BOT_TOKEN);
        (0, events_1.registerEventHandlers)(bot);
        logger_1.logger.info('✅ Бот инициализирован');
        return bot;
    }
    catch (error) {
        logger_1.logger.error('Ошибка инициализации бота', error);
        throw error;
    }
}
async function ensureBotProfile(bot) {
    bot.botInfo = await bot.api.getMyInfo();
}
async function startBotLongPolling(bot) {
    logger_1.logger.info('🚀 Запуск бота (long polling, GET /updates)...');
    try {
        const allowedUpdates = [...subscriptions_1.BOT_WEBHOOK_UPDATE_TYPES];
        await bot.start({ allowedUpdates });
        logger_1.logger.info('🤖 Бот работает и ждёт события');
    }
    catch (error) {
        logger_1.logger.error('Ошибка при запуске long polling', error);
        throw error;
    }
}
function setupGracefulShutdown(bot, options) {
    const onSignal = () => {
        void (async () => {
            logger_1.logger.info('👋 Получен сигнал выключения...');
            (0, channelPoller_1.stopChannelPostPoller)();
            if (options.receiveMode === 'polling') {
                bot.stop();
            }
            if (options.webhookUrl) {
                try {
                    await (0, subscriptions_1.deleteWebhookSubscription)(config_1.config.BOT_TOKEN, options.webhookUrl);
                    logger_1.logger.info('Webhook отписан (DELETE /subscriptions)');
                }
                catch (e) {
                    logger_1.logger.error('Не удалось вызвать DELETE /subscriptions при остановке', e);
                }
            }
            if (options.httpServer) {
                await new Promise((resolve) => {
                    options.httpServer.close(() => resolve());
                });
            }
            logger_1.logger.info('🛑 Остановка завершена');
            process.exit(0);
        })();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
}
//# sourceMappingURL=bot.js.map