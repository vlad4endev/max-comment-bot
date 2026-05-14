"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeBot = initializeBot;
exports.startBot = startBot;
exports.setupGracefulShutdown = setupGracefulShutdown;
const max_bot_api_1 = require("@maxhub/max-bot-api");
const config_1 = require("./config");
const events_1 = require("./handlers/events");
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
async function startBot(bot) {
    logger_1.logger.info('🚀 Запуск бота...');
    try {
        await bot.start();
        logger_1.logger.info('🤖 Бот запущен и ждёт событий');
        logger_1.logger.info('📡 Webhook подписан автоматически MAX Bot API');
    }
    catch (error) {
        logger_1.logger.error('Ошибка при запуске', error);
        throw error;
    }
}
function setupGracefulShutdown(bot) {
    const onSignal = () => {
        logger_1.logger.info('👋 Получен сигнал выключения...');
        bot.stop();
        logger_1.logger.info('🛑 Бот остановлен');
        process.exit(0);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
}
//# sourceMappingURL=bot.js.map