"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAutopostScheduler = startAutopostScheduler;
exports.stopAutopostScheduler = stopAutopostScheduler;
exports.triggerAutopostTick = triggerAutopostTick;
exports.getAutopostSchedulerStatus = getAutopostSchedulerStatus;
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const integrationsStore_1 = require("./integrationsStore");
const autopostSchedule_1 = require("./autopostSchedule");
const postsDatabase_1 = require("../db/postsDatabase");
const autopostStore_1 = require("./autopostStore");
const autopostMaxSender_1 = require("./autopostMaxSender");
const autopostTelegramSender_1 = require("./autopostTelegramSender");
const DEFAULT_TICK_MS = 15_000;
let intervalHandle = null;
let ticking = false;
let tickMs = DEFAULT_TICK_MS;
let startedAt = null;
let lastTickAt = null;
let lastDueCount = 0;
let lastError = null;
function getTickMs() {
    const raw = (process.env.AUTOPOST_TICK_MS ?? '').trim();
    if (raw === '') {
        return DEFAULT_TICK_MS;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
        return DEFAULT_TICK_MS;
    }
    return Math.min(parsed, 300_000);
}
function resolveTelegramToken() {
    const fromEnv = (0, config_1.getTelegramToken)();
    if (fromEnv) {
        return fromEnv;
    }
    const integ = integrationsStore_1.integrationsStore.getTelegramIntegration();
    const token = integ?.token?.trim();
    return token || null;
}
async function afterSuccessfulSend(post) {
    if (post.schedule_type === 'once') {
        (0, autopostStore_1.markAutopostSent)(post.id, { status: 'sent' });
        logger_1.logger.info('autopostScheduler: one-time post sent', { id: post.id, channel: post.target_channel_id });
        return;
    }
    const recurringTime = post.recurring_time;
    const weekdays = post.weekdays;
    if (!recurringTime || !weekdays?.length) {
        (0, autopostStore_1.markAutopostFailed)(post.id, 'recurring schedule misconfigured');
        return;
    }
    const nextAt = (0, autopostSchedule_1.computeNextRecurringAt)(recurringTime, weekdays, new Date(), post.timezone);
    (0, autopostStore_1.markAutopostSent)(post.id, { nextScheduledAt: nextAt, status: 'active' });
    logger_1.logger.info('autopostScheduler: recurring post sent, next scheduled', {
        id: post.id,
        nextAt,
    });
}
async function processDuePost(post) {
    try {
        if (post.platform === 'max') {
            const maxToken = (0, autopostMaxSender_1.resolveMaxToken)();
            if (!maxToken) {
                (0, autopostStore_1.markAutopostFailed)(post.id, 'MAX bot token not configured');
                return;
            }
            await (0, autopostMaxSender_1.sendAutopostToMax)(maxToken, post);
            await afterSuccessfulSend(post);
            return;
        }
        const tgToken = resolveTelegramToken();
        if (!tgToken) {
            (0, autopostStore_1.markAutopostFailed)(post.id, 'Telegram bot token not configured');
            return;
        }
        const result = await (0, autopostTelegramSender_1.sendAutopostToTelegram)(tgToken, post);
        if (result.warning) {
            logger_1.logger.info('autopostScheduler: sent with notice', { id: post.id, warning: result.warning });
        }
        await afterSuccessfulSend(post);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        (0, autopostStore_1.markAutopostFailed)(post.id, message);
        logger_1.logger.error('autopostScheduler: send failed', { id: post.id, platform: post.platform, error: message });
    }
}
async function tick() {
    if (ticking) {
        return;
    }
    ticking = true;
    try {
        const nowIso = new Date().toISOString();
        const due = (0, autopostStore_1.listDueAutoposts)(nowIso);
        lastTickAt = nowIso;
        lastDueCount = due.length;
        lastError = null;
        if (due.length > 0) {
            logger_1.logger.info('autopostScheduler: processing due posts', { count: due.length, ids: due.map((p) => p.id) });
        }
        for (const post of due) {
            await processDuePost(post);
        }
    }
    catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logger_1.logger.error('autopostScheduler: tick failed', { error: lastError });
    }
    finally {
        ticking = false;
    }
}
/**
 * Планировщик автопостов: setInterval раз в минуту (AUTOPOST_TICK_MS).
 */
function startAutopostScheduler() {
    if (intervalHandle) {
        return;
    }
    tickMs = getTickMs();
    startedAt = new Date().toISOString();
    const posts = (0, autopostStore_1.listAutoposts)();
    const active = posts.filter((p) => p.status === 'active').length;
    intervalHandle = setInterval(() => {
        void tick();
    }, tickMs);
    void tick();
    logger_1.logger.info('autopostScheduler: started', {
        tickMs,
        dbPath: postsDatabase_1.POSTS_DB_PATH,
        totalPosts: posts.length,
        activePosts: active,
    });
}
function stopAutopostScheduler() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
}
/** Немедленный проход планировщика (после создания/обновления поста). */
function triggerAutopostTick() {
    void tick();
}
function getAutopostSchedulerStatus() {
    const posts = (0, autopostStore_1.listAutoposts)();
    const nowIso = new Date().toISOString();
    return {
        running: intervalHandle !== null,
        tickMs,
        startedAt,
        lastTickAt,
        lastDueCount,
        lastError,
        dbPath: postsDatabase_1.POSTS_DB_PATH,
        totalPosts: posts.length,
        activePosts: posts.filter((p) => p.status === 'active').length,
        dueNow: (0, autopostStore_1.listDueAutoposts)(nowIso).length,
    };
}
//# sourceMappingURL=autopostScheduler.js.map