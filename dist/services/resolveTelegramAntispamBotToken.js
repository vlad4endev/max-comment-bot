"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTelegramAntispamBotToken = resolveTelegramAntispamBotToken;
exports.isTelegramAntispamBotConfigured = isTelegramAntispamBotConfigured;
/** Токен отдельного Telegram-бота только для антиспама в группах обсуждений. */
function resolveTelegramAntispamBotToken() {
    return (process.env.TG_ANTISPAM_BOT_TOKEN ?? '').trim();
}
function isTelegramAntispamBotConfigured() {
    return resolveTelegramAntispamBotToken().length > 0;
}
//# sourceMappingURL=resolveTelegramAntispamBotToken.js.map