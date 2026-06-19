"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAutopostScheduler = startAutopostScheduler;
exports.stopAutopostScheduler = stopAutopostScheduler;
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const integrationsStore_1 = require("./integrationsStore");
const autopostSchedule_1 = require("./autopostSchedule");
const autopostStore_1 = require("./autopostStore");
const autopostMaxSender_1 = require("./autopostMaxSender");
const autopostTelegramSender_1 = require("./autopostTelegramSender");
const DEFAULT_TICK_MS = 60_000;
let intervalHandle = null;
let ticking = false;
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
    const nextAt = (0, autopostSchedule_1.computeNextRecurringAt)(recurringTime, weekdays);
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
        for (const post of due) {
            await processDuePost(post);
        }
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
    const tickMs = getTickMs();
    intervalHandle = setInterval(() => {
        void tick();
    }, tickMs);
    void tick();
    logger_1.logger.info('autopostScheduler: started', { tickMs });
}
function stopAutopostScheduler() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
}
//# sourceMappingURL=autopostScheduler.js.map