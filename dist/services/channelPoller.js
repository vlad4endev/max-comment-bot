"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RefreshButtonsError = exports.POLL_CONCURRENCY = exports.REFRESH_BUTTON_LOOKBACK_MS = void 0;
exports.syncPerChannelPollers = syncPerChannelPollers;
exports.runChannelPollerForChat = runChannelPollerForChat;
exports.runChannelPollerTick = runChannelPollerTick;
exports.startChannelPostPoller = startChannelPostPoller;
exports.restartChannelPostPoller = restartChannelPostPoller;
exports.clearChannelPollerErrors = clearChannelPollerErrors;
exports.stopChannelPostPoller = stopChannelPostPoller;
exports.notifyChannelRegistryChanged = notifyChannelRegistryChanged;
const adminRuntimeSettingsStore_1 = require("./adminRuntimeSettingsStore");
const channelAdminJoinNotified_1 = require("./channelAdminJoinNotified");
const channelRegistry_1 = require("./channelRegistry");
const commentButtonRetryQueue_1 = require("./commentButtonRetryQueue");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const logger_1 = require("../utils/logger");
const maxApiRetry_1 = require("../utils/maxApiRetry");
const channelPostActions_1 = require("./channelPostActions");
const postStore_1 = require("./postStore");
const MIN_POLL_INTERVAL_MS = 3_000;
/** Верхняя граница интервала опроса одного канала (стабильность важнее редкого глобального 30 с). */
const PER_CHANNEL_CAP_MS = 6_000;
const FETCH_COUNT = 15;
/** Admin «обновить кнопки»: окно сканирования (последние сутки). */
exports.REFRESH_BUTTON_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const REFRESH_MESSAGES_PAGE_SIZE = 100;
/** До 30×100 сообщений за сутки на канал (защита от бесконечного цикла). */
const REFRESH_MAX_PAGES = 30;
/** Exported for startup diagnostics. */
exports.POLL_CONCURRENCY = 8;
const DISABLE_AFTER_ERRORS = 5;
const channelTimers = new Map();
const errorCount = new Map();
let botRef = null;
let perChannelIntervalMs = PER_CHANNEL_CAP_MS;
function resolvePerChannelIntervalMs(globalMs) {
    return Math.max(MIN_POLL_INTERVAL_MS, Math.min(globalMs, PER_CHANNEL_CAP_MS));
}
async function pollChannel(bot, channel, botUid) {
    const stats = { fetched: 0, candidates: 0, attached: 0, failed: 0 };
    const { messages } = await (0, maxApiRetry_1.apiCallWithRetry)(() => bot.api.getMessages(channel.chat_id, { count: FETCH_COUNT }));
    stats.fetched = messages.length;
    for (const message of messages) {
        const mid = message.body?.mid;
        if (typeof mid !== 'string' || mid.trim() === '') {
            continue;
        }
        const knownPost = postStore_1.postStore.findPostByChannelMessage(channel.chat_id, mid);
        if (knownPost && knownPost.button_attach_pending !== true) {
            continue;
        }
        stats.candidates += 1;
        const r = await (0, channelPostActions_1.tryAttachCommentsToChannelPost)(bot, message, {
            botUserId: botUid,
            channelChatIdOverride: channel.chat_id,
            skipAuthorAdminCheck: true,
            source: 'poller',
        });
        if (r.ok) {
            stats.attached += 1;
        }
        else if (r.reason === 'attach_failed') {
            stats.failed += 1;
            (0, commentButtonRetryQueue_1.scheduleCommentButtonRetry)(channel.chat_id, mid);
        }
    }
    if (stats.candidates > 0 || stats.attached > 0) {
        logger_1.logger.info('channelPoller: channel sweep', {
            chatId: channel.chat_id,
            ...stats,
        });
    }
    return stats;
}
async function pollChannelSafe(bot, channel, botUid) {
    try {
        await pollChannel(bot, channel, botUid);
        errorCount.delete(channel.chat_id);
    }
    catch (err) {
        const count = (errorCount.get(channel.chat_id) ?? 0) + 1;
        errorCount.set(channel.chat_id, count);
        logger_1.logger.error(`channelPoller: error for ${channel.chat_id} (${count}/${DISABLE_AFTER_ERRORS})`, err);
        if (count >= DISABLE_AFTER_ERRORS) {
            logger_1.logger.warn(`channelPoller: disabling channel ${channel.chat_id} after ${count} errors`);
            (0, channelAdminJoinNotified_1.clearAdminJoinNotifiedForChannel)(channel.chat_id);
            channelRegistry_1.channelRegistry.deactivate(channel.chat_id);
            errorCount.delete(channel.chat_id);
            stopChannelTimer(channel.chat_id);
        }
    }
}
function stopChannelTimer(chatId) {
    const t = channelTimers.get(chatId);
    if (t !== undefined) {
        clearInterval(t);
        channelTimers.delete(chatId);
    }
}
/**
 * У каждого канала свой таймер — очередь не блокирует «хвостовые» каналы на минуты.
 */
function syncPerChannelPollers(bot) {
    if (!(0, postStore_1.isMiniAppOpenUrlConfigured)()) {
        return;
    }
    botRef = bot;
    const channels = channelRegistry_1.channelRegistry.getAllChannels().filter((c) => c.type === 'channel');
    const activeIds = new Set(channels.map((c) => c.chat_id));
    for (const chatId of [...channelTimers.keys()]) {
        if (!activeIds.has(chatId)) {
            stopChannelTimer(chatId);
        }
    }
    const botUid = bot.botInfo?.user_id;
    for (const channel of channels) {
        if (channelTimers.has(channel.chat_id)) {
            continue;
        }
        void pollChannelSafe(bot, channel, botUid);
        const timer = setInterval(() => {
            if (!botRef) {
                return;
            }
            void pollChannelSafe(botRef, channel, botRef.botInfo?.user_id);
        }, perChannelIntervalMs);
        channelTimers.set(channel.chat_id, timer);
    }
    logger_1.logger.info('channelPoller: per-channel timers synced', {
        channelCount: channels.length,
        perChannelIntervalMs,
        fetchCount: FETCH_COUNT,
    });
}
function postTimestampMs(post) {
    const t = Date.parse(post.timestamp);
    return Number.isFinite(t) ? t : 0;
}
/** MAX API: `timestamp` в секундах или миллисекундах. */
function messageTimestampMs(message) {
    const ts = message.timestamp;
    return ts > 1e12 ? ts : ts * 1000;
}
function messageTimestampSec(message) {
    return Math.floor(messageTimestampMs(message) / 1000);
}
function isWithinLookbackMs(atMs, cutoffMs) {
    return atMs >= cutoffMs;
}
/**
 * Сообщения канала за последние сутки (пагинация GET /messages, newest-first).
 */
async function fetchChannelMessagesSince(bot, chatId, cutoffMs) {
    const cutoffSec = Math.floor(cutoffMs / 1000);
    const collected = [];
    let pageFrom;
    for (let page = 0; page < REFRESH_MAX_PAGES; page += 1) {
        const extra = {
            count: REFRESH_MESSAGES_PAGE_SIZE,
            to: cutoffSec,
        };
        if (pageFrom !== undefined) {
            extra.from = pageFrom;
        }
        const { messages: batch } = await (0, maxApiRetry_1.apiCallWithRetry)(() => bot.api.getMessages(chatId, extra));
        if (batch.length === 0) {
            break;
        }
        let reachedOlderThanWindow = false;
        for (const message of batch) {
            if (isWithinLookbackMs(messageTimestampMs(message), cutoffMs)) {
                collected.push(message);
            }
            else {
                reachedOlderThanWindow = true;
            }
        }
        const oldest = batch[batch.length - 1];
        if (reachedOlderThanWindow || batch.length < REFRESH_MESSAGES_PAGE_SIZE) {
            break;
        }
        pageFrom = messageTimestampSec(oldest);
        if (pageFrom <= cutoffSec) {
            break;
        }
    }
    return collected;
}
function applyRefreshAttachResult(stats, r, wasInDb) {
    if (r.ok) {
        if (wasInDb) {
            stats.refreshed += 1;
        }
        else {
            stats.created += 1;
        }
        return;
    }
    if (r.reason === 'already_exists') {
        stats.refreshed += 1;
        return;
    }
    if (r.reason === 'skip_bot' ||
        r.reason === 'no_mid' ||
        r.reason === 'no_chat_id' ||
        r.reason === 'not_admin') {
        stats.skipped += 1;
        return;
    }
    stats.failed += 1;
}
class RefreshButtonsError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'RefreshButtonsError';
    }
}
exports.RefreshButtonsError = RefreshButtonsError;
/**
 * One sweep for a single channel (admin «обновить кнопки»).
 */
async function runChannelPollerForChat(bot, chatId) {
    if (!(0, postStore_1.isMiniAppOpenUrlConfigured)()) {
        throw new RefreshButtonsError('miniapp_not_configured', 'Не заданы BOT_NICKNAME или MINI_APP_URL — ссылки на Mini App недоступны');
    }
    const canonicalChatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chatId) ?? chatId;
    const reg = channelRegistry_1.channelRegistry.getChannel(canonicalChatId) ?? channelRegistry_1.channelRegistry.getChannel(chatId);
    if (!reg || reg.type !== 'channel') {
        throw new RefreshButtonsError('channel_not_found', 'Канал не найден в реестре бота');
    }
    const cutoffMs = Date.now() - exports.REFRESH_BUTTON_LOOKBACK_MS;
    const lookbackHours = Math.round(exports.REFRESH_BUTTON_LOOKBACK_MS / (60 * 60 * 1000));
    const stats = {
        chat_id: reg.chat_id,
        lookback_hours: lookbackHours,
        messages_fetched: 0,
        posts_in_db: 0,
        posts_in_db_total: 0,
        created: 0,
        refreshed: 0,
        skipped: 0,
        failed: 0,
    };
    const botUid = bot.botInfo?.user_id;
    const knownPosts = postStore_1.postStore.getPostsByChatId(reg.chat_id);
    stats.posts_in_db_total = knownPosts.length;
    const recentPosts = knownPosts.filter((post) => isWithinLookbackMs(postTimestampMs(post), cutoffMs));
    stats.posts_in_db = recentPosts.length;
    const processedMids = new Set();
    logger_1.logger.info('channelPoller: refresh window', {
        chatId: reg.chat_id,
        lookbackHours,
        postsInDbTotal: stats.posts_in_db_total,
        postsInDbRecent: stats.posts_in_db,
        cutoffIso: new Date(cutoffMs).toISOString(),
    });
    for (const post of recentPosts) {
        processedMids.add(post.message_mid);
        if (post.comments_ui_message_mid) {
            processedMids.add(post.comments_ui_message_mid);
        }
        const message = await (0, channelPostActions_1.loadChannelPostMessage)(bot, post);
        if (!message?.body?.mid) {
            stats.failed += 1;
            (0, commentButtonRetryQueue_1.scheduleCommentButtonRetry)(reg.chat_id, post.message_mid);
            continue;
        }
        const r = await (0, channelPostActions_1.tryAttachCommentsToChannelPost)(bot, message, {
            botUserId: botUid,
            channelChatIdOverride: reg.chat_id,
            skipAuthorAdminCheck: true,
            source: 'refresh',
        });
        applyRefreshAttachResult(stats, r, true);
        if (!r.ok && r.reason === 'attach_failed') {
            (0, commentButtonRetryQueue_1.scheduleCommentButtonRetry)(reg.chat_id, post.message_mid);
        }
    }
    let messages;
    try {
        messages = await fetchChannelMessagesSince(bot, reg.chat_id, cutoffMs);
    }
    catch (err) {
        logger_1.logger.warn('channelPoller: runChannelPollerForChat getMessages failed', {
            chatId: reg.chat_id,
            err,
        });
        throw new RefreshButtonsError('api_error', 'Не удалось получить сообщения канала (проверьте права бота)');
    }
    stats.messages_fetched = messages.length;
    for (const message of messages) {
        const mid = message.body?.mid;
        if (typeof mid !== 'string' || mid.trim() === '' || processedMids.has(mid)) {
            continue;
        }
        const linkedPost = postStore_1.postStore.findPostByCommentsUiMessage(reg.chat_id, mid);
        if (linkedPost) {
            processedMids.add(mid);
            continue;
        }
        const wasInDb = postStore_1.postStore.findPostByChannelMessage(reg.chat_id, mid) !== null;
        const r = await (0, channelPostActions_1.tryAttachCommentsToChannelPost)(bot, message, {
            botUserId: botUid,
            channelChatIdOverride: reg.chat_id,
            skipAuthorAdminCheck: true,
            source: 'refresh',
        });
        applyRefreshAttachResult(stats, r, wasInDb);
        if (!r.ok && r.reason === 'attach_failed' && mid) {
            (0, commentButtonRetryQueue_1.scheduleCommentButtonRetry)(reg.chat_id, mid);
        }
        processedMids.add(mid);
    }
    logger_1.logger.info('channelPoller: runChannelPollerForChat done', stats);
    return stats;
}
/**
 * @deprecated Используется syncPerChannelPollers; оставлено для совместимости вызовов.
 */
async function runChannelPollerTick(bot) {
    syncPerChannelPollers(bot);
}
/**
 * Запускает опрос каждого канала по отдельному таймеру + синхронизацию при изменении реестра.
 */
function startChannelPostPoller(bot, intervalMs) {
    if (!(0, postStore_1.isMiniAppOpenUrlConfigured)()) {
        logger_1.logger.info('channelPoller: disabled (BOT_NICKNAME / MINI_APP_URL not set for Mini App links)');
        return;
    }
    const fromStoreOrArg = intervalMs !== undefined && Number.isFinite(intervalMs)
        ? intervalMs
        : adminRuntimeSettingsStore_1.adminRuntimeSettingsStore.getPollIntervalMs();
    perChannelIntervalMs = resolvePerChannelIntervalMs(fromStoreOrArg);
    stopChannelPostPoller();
    syncPerChannelPollers(bot);
    logger_1.logger.info('channelPoller: started (per-channel)', {
        channelCount: channelRegistry_1.channelRegistry.getAllChannels().filter((c) => c.type === 'channel').length,
        perChannelIntervalMs,
        fetchCount: FETCH_COUNT,
        pollConcurrency: exports.POLL_CONCURRENCY,
    });
}
/**
 * Перезапуск таймеров с разрешением из {@link adminRuntimeSettingsStore}.
 */
function restartChannelPostPoller(bot) {
    startChannelPostPoller(bot);
}
/** Сбрасывает счётчик ошибок поллера для канала (после полного отключения). */
function clearChannelPollerErrors(chatId) {
    const abs = Math.abs(chatId);
    for (const key of [...errorCount.keys()]) {
        if (Math.abs(key) === abs) {
            errorCount.delete(key);
        }
    }
}
function stopChannelPostPoller() {
    for (const chatId of [...channelTimers.keys()]) {
        stopChannelTimer(chatId);
    }
    botRef = null;
    logger_1.logger.info('channelPoller: stopped');
}
/** Вызвать после добавления/удаления канала в реестре (если поллер уже запущен). */
function notifyChannelRegistryChanged() {
    if (botRef) {
        syncPerChannelPollers(botRef);
    }
}
//# sourceMappingURL=channelPoller.js.map