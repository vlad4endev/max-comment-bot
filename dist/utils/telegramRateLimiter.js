"use strict";
/**
 * Очередь и rate limiting для Telegram Bot API.
 * Сериализует исходящие запросы, соблюдает минимальный интервал и обрабатывает FLOOD_WAIT.
 */
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTelegramApiMinIntervalMs = getTelegramApiMinIntervalMs;
exports.getTelegramCommentSyncBatchSize = getTelegramCommentSyncBatchSize;
exports.getMaxCommentSyncIntervalMs = getMaxCommentSyncIntervalMs;
exports.parseFloodWaitSeconds = parseFloodWaitSeconds;
exports.isTelegramApiPaused = isTelegramApiPaused;
exports.getTelegramApiPauseRemainingMs = getTelegramApiPauseRemainingMs;
exports.enqueueTelegramApiCall = enqueueTelegramApiCall;
exports.callTelegramBotApi = callTelegramBotApi;
exports.withTelegramFloodWaitBackoff = withTelegramFloodWaitBackoff;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("./logger");
const telegramSyncErrors_1 = require("./telegramSyncErrors");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Минимальный интервал между вызовами Bot API (мс). По умолчанию 2000. */
function getTelegramApiMinIntervalMs() {
    const raw = (process.env.TELEGRAM_API_MIN_INTERVAL_MS ?? '').trim();
    if (raw === '') {
        return 2_000;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1_000) {
        return 2_000;
    }
    return Math.min(parsed, 10_000);
}
/** Сколько комментариев обрабатывать за один цикл синхронизации MAX→TG. */
function getTelegramCommentSyncBatchSize() {
    const raw = (process.env.TELEGRAM_COMMENT_SYNC_BATCH_SIZE ?? '').trim();
    if (raw === '') {
        return 5;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return 5;
    }
    return Math.min(parsed, 25);
}
/** Интервал цикла синхронизации комментариев MAX→TG (мс). */
function getMaxCommentSyncIntervalMs() {
    const raw = (process.env.MAX_COMMENT_SYNC_INTERVAL_MS ?? '').trim();
    if (raw === '') {
        return 30_000;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 5_000) {
        return 30_000;
    }
    return Math.min(parsed, 300_000);
}
function parseFloodWaitSeconds(text, parameters) {
    const fromParams = parameters?.retry_after;
    if (typeof fromParams === 'number' && Number.isFinite(fromParams) && fromParams > 0) {
        return Math.ceil(fromParams);
    }
    const match = /retry after (\d+)/i.exec(text);
    if (match?.[1]) {
        return Math.max(1, Number.parseInt(match[1], 10));
    }
    const floodMatch = /FLOOD_WAIT_?(\d+)/i.exec(text);
    if (floodMatch?.[1]) {
        return Math.max(1, Number.parseInt(floodMatch[1], 10));
    }
    return null;
}
let chain = Promise.resolve();
let lastCallAt = 0;
let globalPauseUntil = 0;
function isTelegramApiPaused() {
    return Date.now() < globalPauseUntil;
}
function getTelegramApiPauseRemainingMs() {
    return Math.max(0, globalPauseUntil - Date.now());
}
function extendGlobalPause(seconds) {
    const until = Date.now() + (seconds + 1) * 1_000;
    if (until > globalPauseUntil) {
        globalPauseUntil = until;
        logger_1.logger.warn('[telegramRateLimiter] global pause extended', {
            waitSeconds: seconds,
            pauseUntil: new Date(globalPauseUntil).toISOString(),
        });
    }
}
async function waitForSlot() {
    const minInterval = getTelegramApiMinIntervalMs();
    const now = Date.now();
    const pauseWait = globalPauseUntil - now;
    if (pauseWait > 0) {
        await sleep(pauseWait);
    }
    const intervalWait = lastCallAt + minInterval - Date.now();
    if (intervalWait > 0) {
        await sleep(intervalWait);
    }
    lastCallAt = Date.now();
}
/**
 * Сериализует вызовы Telegram Bot API с минимальным интервалом и учётом FLOOD_WAIT.
 */
function enqueueTelegramApiCall(fn) {
    const run = async () => {
        await waitForSlot();
        return fn();
    };
    const result = chain.then(run, run);
    chain = result.then(() => undefined, () => undefined);
    return result;
}
/**
 * POST к Telegram Bot API с rate limiting, retry при FLOOD_WAIT и классификацией ошибок.
 */
async function callTelegramBotApi(token, method, payload, context = { method }, maxFloodRetries = 3) {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    const rawChatId = payload.chat_id ?? context.chatId;
    const chatId = typeof rawChatId === 'number' || typeof rawChatId === 'string' ? rawChatId : undefined;
    for (let attempt = 0; attempt <= maxFloodRetries; attempt += 1) {
        let data;
        try {
            data = await enqueueTelegramApiCall(async () => {
                const { data: response } = await axios_1.default.post(url, payload, { timeout: 20_000 });
                return response;
            });
        }
        catch (err) {
            const errText = (0, telegramSyncErrors_1.extractTelegramErrorText)(err);
            if ((0, telegramSyncErrors_1.isTelegramUnauthorizedError)(errText)) {
                const { reportTelegramUnauthorized } = await Promise.resolve().then(() => __importStar(require('../services/telegramSyncAlertService')));
                void reportTelegramUnauthorized({ method, description: errText });
            }
            throw err;
        }
        if (data.ok) {
            return data;
        }
        const description = data.description ?? '';
        if ((0, telegramSyncErrors_1.isTelegramUnauthorizedError)(description) || data.error_code === 401) {
            const { reportTelegramUnauthorized } = await Promise.resolve().then(() => __importStar(require('../services/telegramSyncAlertService')));
            void reportTelegramUnauthorized({ method, description });
            return data;
        }
        const floodSeconds = parseFloodWaitSeconds(description, data.parameters);
        if (floodSeconds != null && attempt < maxFloodRetries) {
            extendGlobalPause(floodSeconds);
            const { reportTelegramFloodWait } = await Promise.resolve().then(() => __importStar(require('../services/telegramSyncAlertService')));
            void reportTelegramFloodWait({
                method,
                chatId,
                waitSeconds: floodSeconds,
                description,
            });
            continue;
        }
        if ((0, telegramSyncErrors_1.isTelegramForbiddenError)(description)) {
            const { reportTelegramForbidden } = await Promise.resolve().then(() => __importStar(require('../services/telegramSyncAlertService')));
            void reportTelegramForbidden({
                method,
                chatId,
                description,
            });
        }
        return data;
    }
    throw new Error('Telegram API: unexpected flood-wait retry exhaustion');
}
/**
 * Оборачивает MTProto/другие вызовы с FLOOD_WAIT в ту же глобальную паузу.
 */
async function withTelegramFloodWaitBackoff(label, run, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        await waitForSlot();
        try {
            lastCallAt = Date.now();
            return await run();
        }
        catch (err) {
            const errText = (0, telegramSyncErrors_1.extractTelegramErrorText)(err);
            const floodSeconds = parseFloodWaitSeconds(errText);
            if (floodSeconds != null && attempt < maxRetries) {
                extendGlobalPause(floodSeconds);
                const { reportTelegramFloodWait } = await Promise.resolve().then(() => __importStar(require('../services/telegramSyncAlertService')));
                void reportTelegramFloodWait({
                    method: label,
                    waitSeconds: floodSeconds,
                    description: errText,
                });
                continue;
            }
            throw err;
        }
    }
    throw new Error(`Telegram flood-wait retry exhausted: ${label}`);
}
//# sourceMappingURL=telegramRateLimiter.js.map