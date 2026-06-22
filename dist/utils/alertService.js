"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendAdminAlert = sendAdminAlert;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const logger_1 = require("./logger");
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const lastAlerts = new Map();
async function sendAdminAlert(code, message, details) {
    const now = Date.now();
    const lastSent = lastAlerts.get(code) ?? 0;
    if (now - lastSent < ALERT_COOLDOWN_MS) {
        return;
    }
    lastAlerts.set(code, now);
    const text = [
        '⚠️ МаксКоммент: ' + message,
        details ? '```\n' + JSON.stringify(details, null, 2).slice(0, 500) + '\n```' : '',
    ]
        .filter(Boolean)
        .join('\n');
    try {
        const adminId = config_1.config.ADMIN_CHAT_ID;
        const tgBotToken = (0, config_1.getTelegramToken)();
        if (!adminId || !tgBotToken) {
            return;
        }
        await axios_1.default.post(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
            chat_id: adminId,
            text,
            parse_mode: 'Markdown',
        }, { timeout: 10_000 });
    }
    catch (err) {
        logger_1.logger.warn('[alertService] failed to send alert', { code, err });
    }
}
//# sourceMappingURL=alertService.js.map