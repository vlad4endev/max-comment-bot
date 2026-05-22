"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveTelegramBotToken = resolveTelegramBotToken;
exports.isMainTelegramBotToken = isMainTelegramBotToken;
const config_1 = require("../config");
const integrationsStore_1 = require("./integrationsStore");
/** Токен основного CommentBot в Telegram (integrations или TG_TOKEN). */
function resolveTelegramBotToken() {
    const integ = integrationsStore_1.integrationsStore.getTelegramIntegration();
    const fromInteg = integ?.token?.trim() ?? '';
    if (fromInteg) {
        return fromInteg;
    }
    return (0, config_1.getTelegramToken)().trim();
}
function isMainTelegramBotToken(token) {
    const main = resolveTelegramBotToken();
    if (!main) {
        return false;
    }
    return token.trim() === main;
}
//# sourceMappingURL=resolveTelegramBotToken.js.map