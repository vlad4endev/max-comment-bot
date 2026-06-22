"use strict";
/**
 * Периодическая проверка авторизации Telegram Bot API (getMe).
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeTelegramBotApi = probeTelegramBotApi;
exports.getTelegramHealthSnapshot = getTelegramHealthSnapshot;
exports.assertTelegramBotApiOnStartup = assertTelegramBotApiOnStartup;
exports.startTelegramHealthMonitor = startTelegramHealthMonitor;
exports.stopTelegramHealthMonitor = stopTelegramHealthMonitor;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("../utils/logger");
const telegramSyncErrors_1 = require("../utils/telegramSyncErrors");
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const telegramSyncAlertService_1 = require("./telegramSyncAlertService");
const TG_API = 'https://api.telegram.org';
let lastSnapshot = {
    checked_at: new Date(0).toISOString(),
    has_token: false,
    api_ok: false,
    bot_id: null,
    bot_username: null,
    error: null,
};
let monitorTimer = null;
function getMonitorIntervalMs() {
    const raw = (process.env.TELEGRAM_HEALTH_CHECK_INTERVAL_MS ?? '').trim();
    if (raw === '') {
        return 5 * 60_000;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 30_000) {
        return 5 * 60_000;
    }
    return Math.min(parsed, 60 * 60_000);
}
function extractAxiosErrorText(err) {
    if (axios_1.default.isAxiosError(err)) {
        const status = err.response?.status;
        const data = err.response?.data;
        if (typeof data === 'object' && data !== null && 'description' in data) {
            const description = String(data.description ?? '').trim();
            if (description) {
                return status != null ? `${status}: ${description}` : description;
            }
        }
        if (status != null) {
            return `HTTP ${status}`;
        }
    }
    return err instanceof Error ? err.message : String(err ?? '');
}
async function probeTelegramBotApi(token) {
    const trimmed = (token ?? (0, resolveTelegramBotToken_1.resolveTelegramBotToken)()).trim();
    const checkedAt = new Date().toISOString();
    if (!trimmed) {
        const snapshot = {
            checked_at: checkedAt,
            has_token: false,
            api_ok: false,
            bot_id: null,
            bot_username: null,
            error: 'Токен Telegram не задан',
        };
        lastSnapshot = snapshot;
        return snapshot;
    }
    try {
        const { data, status } = await axios_1.default.get(`${TG_API}/bot${trimmed}/getMe`, { timeout: 15_000 });
        if (!data.ok || !data.result) {
            const description = data.description ?? `HTTP ${status}`;
            const snapshot = {
                checked_at: checkedAt,
                has_token: true,
                api_ok: false,
                bot_id: null,
                bot_username: null,
                error: description,
            };
            lastSnapshot = snapshot;
            if ((0, telegramSyncErrors_1.isTelegramUnauthorizedError)(description) || data.error_code === 401) {
                void (0, telegramSyncAlertService_1.reportTelegramUnauthorized)({ method: 'getMe', description });
            }
            return snapshot;
        }
        const snapshot = {
            checked_at: checkedAt,
            has_token: true,
            api_ok: true,
            bot_id: typeof data.result.id === 'number' ? data.result.id : null,
            bot_username: data.result.username?.trim() || null,
            error: null,
        };
        lastSnapshot = snapshot;
        return snapshot;
    }
    catch (err) {
        const errorText = extractAxiosErrorText(err);
        const snapshot = {
            checked_at: checkedAt,
            has_token: true,
            api_ok: false,
            bot_id: null,
            bot_username: null,
            error: errorText,
        };
        lastSnapshot = snapshot;
        if ((0, telegramSyncErrors_1.isTelegramUnauthorizedError)(errorText)) {
            void (0, telegramSyncAlertService_1.reportTelegramUnauthorized)({ method: 'getMe', description: errorText });
        }
        return snapshot;
    }
}
function getTelegramHealthSnapshot() {
    return { ...lastSnapshot };
}
async function assertTelegramBotApiOnStartup() {
    const token = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
    if (!token) {
        logger_1.logger.warn('[telegramHealth] TG_TOKEN не задан — синхронизация с Telegram отключена до подключения интеграции');
        return;
    }
    const snapshot = await probeTelegramBotApi(token);
    if (snapshot.api_ok) {
        logger_1.logger.info('[telegramHealth] Telegram Bot API авторизован', {
            bot_id: snapshot.bot_id,
            bot_username: snapshot.bot_username,
        });
        return;
    }
    logger_1.logger.error('[telegramHealth] Telegram Bot API недоступен — проверьте токен в интеграциях', {
        error: snapshot.error,
    });
}
function startTelegramHealthMonitor() {
    if (monitorTimer) {
        return;
    }
    const intervalMs = getMonitorIntervalMs();
    monitorTimer = setInterval(() => {
        void probeTelegramBotApi().catch((err) => {
            logger_1.logger.warn('[telegramHealth] periodic probe failed', err);
        });
    }, intervalMs);
    monitorTimer.unref?.();
    logger_1.logger.info('[telegramHealth] мониторинг Telegram API запущен', { intervalMs });
}
function stopTelegramHealthMonitor() {
    if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
    }
}
//# sourceMappingURL=telegramHealthService.js.map