"use strict";
/**
 * Троттлированные уведомления оператору о критических ошибках синхронизации Telegram.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.setTelegramSyncAlertBot = setTelegramSyncAlertBot;
exports.reportTelegramFloodWait = reportTelegramFloodWait;
exports.reportTelegramForbidden = reportTelegramForbidden;
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const ALERT_COOLDOWN_MS = 15 * 60 * 1_000;
const lastAlertAt = new Map();
let botRef = null;
function setTelegramSyncAlertBot(bot) {
    botRef = bot;
}
function alertKey(kind, chatId) {
    return `${kind}:${chatId ?? 'global'}`;
}
function shouldNotify(kind, chatId) {
    const key = alertKey(kind, chatId);
    const now = Date.now();
    const last = lastAlertAt.get(key) ?? 0;
    if (now - last < ALERT_COOLDOWN_MS) {
        return false;
    }
    lastAlertAt.set(key, now);
    return true;
}
async function deliverOperatorAlert(text) {
    const bot = botRef;
    if (!bot) {
        logger_1.logger.warn('[telegramSyncAlert] bot not set, alert skipped', { text: text.slice(0, 120) });
        return;
    }
    try {
        await bot.api.sendMessageToChat(config_1.config.ADMIN_CHAT_ID, text);
    }
    catch (err) {
        logger_1.logger.warn('[telegramSyncAlert] failed to notify operator', { err });
    }
}
async function reportTelegramFloodWait(input) {
    logger_1.logger.warn('[telegramSyncAlert] FLOOD_WAIT', input);
    if (!shouldNotify('flood_wait', input.chatId)) {
        return;
    }
    const chatPart = input.chatId != null ? `\nЧат: ${String(input.chatId)}` : '';
    const text = `⚠️ Telegram FLOOD_WAIT (${input.waitSeconds} с)\n` +
        `Метод: ${input.method}${chatPart}\n` +
        `${input.description}\n\n` +
        `Синхронизация комментариев приостановлена. ` +
        `Увеличьте TELEGRAM_API_MIN_INTERVAL_MS (сейчас рекомендуется ≥2000).`;
    await deliverOperatorAlert(text);
}
async function reportTelegramForbidden(input) {
    logger_1.logger.warn('[telegramSyncAlert] forbidden', input);
    if (!shouldNotify('forbidden', input.chatId)) {
        return;
    }
    const chatPart = input.chatId != null ? `\nЧат: ${String(input.chatId)}` : '';
    const text = `🚫 Telegram 403 Forbidden\n` +
        `Метод: ${input.method}${chatPart}\n` +
        `${input.description}\n\n` +
        `Проверьте: бот в канале и группе обсуждений, права администратора, токен.`;
    await deliverOperatorAlert(text);
}
//# sourceMappingURL=telegramSyncAlertService.js.map