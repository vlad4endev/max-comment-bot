"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startPostLinkAutoRecovery = startPostLinkAutoRecovery;
exports.stopPostLinkAutoRecovery = stopPostLinkAutoRecovery;
exports.getPostLinkAutoRecoveryStats = getPostLinkAutoRecoveryStats;
const tieredCache_1 = require("../cache/tieredCache");
const channelPostActions_1 = require("./channelPostActions");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const postStore_1 = require("./postStore");
const logger_1 = require("../utils/logger");
const RECOVERY_DEDUP_MS = 2 * 60 * 1000;
const RECOVERY_DEDUP_SEC = Math.ceil(RECOVERY_DEDUP_MS / 1000);
const recentRecoveries = new Map();
let unsubscribeLogger = null;
let queue = Promise.resolve();
let botRef = null;
const recoveryStats = {
    total_recovered: 0,
    total_failed: 0,
    today_recovered: 0,
    today_failed: 0,
    today_key: new Date().toISOString().slice(0, 10),
};
function rotateDailyStatsIfNeeded() {
    const key = new Date().toISOString().slice(0, 10);
    if (recoveryStats.today_key === key) {
        return;
    }
    recoveryStats.today_key = key;
    recoveryStats.today_recovered = 0;
    recoveryStats.today_failed = 0;
}
function markRecovered() {
    rotateDailyStatsIfNeeded();
    recoveryStats.total_recovered += 1;
    recoveryStats.today_recovered += 1;
}
function markFailed() {
    rotateDailyStatsIfNeeded();
    recoveryStats.total_failed += 1;
    recoveryStats.today_failed += 1;
}
function asRecord(v) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        return null;
    }
    return v;
}
function asInt(v) {
    if (typeof v === 'number' && Number.isInteger(v)) {
        return v;
    }
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number.parseInt(v, 10);
        if (Number.isInteger(n)) {
            return n;
        }
    }
    return null;
}
function asNonEmptyString(v) {
    if (typeof v !== 'string') {
        return null;
    }
    const t = v.trim();
    return t === '' ? null : t;
}
function dedupKey(chatId, messageMid) {
    return `${Math.abs(chatId)}|${messageMid}`;
}
async function shouldRunRecovery(chatId, messageMid) {
    const key = dedupKey(chatId, messageMid);
    const lockAcquired = await (0, tieredCache_1.cacheTryAcquireLock)(`recovery:${key}`, RECOVERY_DEDUP_SEC);
    if (lockAcquired) {
        recentRecoveries.set(key, Date.now());
        return true;
    }
    const now = Date.now();
    const prev = recentRecoveries.get(key) ?? 0;
    if (now - prev < RECOVERY_DEDUP_MS) {
        return false;
    }
    recentRecoveries.set(key, now);
    if (recentRecoveries.size > 2000) {
        for (const [k, at] of recentRecoveries) {
            if (now - at > RECOVERY_DEDUP_MS * 3) {
                recentRecoveries.delete(k);
            }
        }
    }
    return true;
}
async function runRecoveryTask(task) {
    const bot = botRef;
    if (!bot) {
        return;
    }
    const canonicalChatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(task.chatId) ?? task.chatId;
    const restored = await (0, channelPostActions_1.ensurePostFromChannelMessage)(bot, canonicalChatId, task.messageMid);
    if (restored) {
        markRecovered();
        logger_1.logger.info('postLinkAutoRecovery: восстановлено по лог-сигналу', {
            reason: task.reason,
            chatId: canonicalChatId,
            messageMid: task.messageMid,
            postId: restored.post_id,
        });
        return;
    }
    markFailed();
    logger_1.logger.warn('postLinkAutoRecovery: не удалось восстановить пост по лог-сигналу', {
        reason: task.reason,
        chatId: canonicalChatId,
        messageMid: task.messageMid,
    });
}
function enqueueRecovery(task) {
    void shouldRunRecovery(task.chatId, task.messageMid).then((ok) => {
        if (!ok) {
            return;
        }
        queue = queue
            .then(async () => {
            await runRecoveryTask(task);
        })
            .catch((err) => {
            logger_1.logger.warn('postLinkAutoRecovery: task failed', { err });
        });
    });
}
function extractTaskFromLogEvent(event) {
    const extra = asRecord(event.extra);
    if (!extra) {
        return null;
    }
    if (event.message === 'miniapp: post lookup' && extra.found === false) {
        const chatId = asInt(extra.chatId);
        const messageMid = asNonEmptyString(extra.messageMid);
        if (chatId === null || !messageMid) {
            return null;
        }
        return {
            chatId,
            messageMid,
            reason: 'miniapp_post_lookup_not_found',
        };
    }
    if (event.message.includes('post_id в ссылке не совпадает')) {
        const chatId = asInt(extra.chatId);
        const messageMid = asNonEmptyString(extra.messageMid);
        if (chatId !== null && messageMid) {
            return {
                chatId,
                messageMid,
                reason: 'post_id_mismatch',
            };
        }
        const requestedPostId = asNonEmptyString(extra.requestedPostId);
        if (!requestedPostId) {
            return null;
        }
        const post = postStore_1.postStore.getPost(requestedPostId);
        if (!post?.message_mid) {
            return null;
        }
        return {
            chatId: post.chat_id,
            messageMid: post.message_mid,
            reason: 'post_id_mismatch',
        };
    }
    return null;
}
function startPostLinkAutoRecovery(bot) {
    botRef = bot;
    if (unsubscribeLogger) {
        return;
    }
    unsubscribeLogger = (0, logger_1.subscribeLoggerEvents)((event) => {
        const task = extractTaskFromLogEvent(event);
        if (!task) {
            return;
        }
        enqueueRecovery(task);
    });
    logger_1.logger.info('postLinkAutoRecovery: started');
}
function stopPostLinkAutoRecovery() {
    if (unsubscribeLogger) {
        unsubscribeLogger();
        unsubscribeLogger = null;
    }
    botRef = null;
    logger_1.logger.info('postLinkAutoRecovery: stopped');
}
function getPostLinkAutoRecoveryStats() {
    rotateDailyStatsIfNeeded();
    return {
        total_recovered: recoveryStats.total_recovered,
        total_failed: recoveryStats.total_failed,
        today_recovered: recoveryStats.today_recovered,
        today_failed: recoveryStats.today_failed,
        today_key: recoveryStats.today_key,
    };
}
//# sourceMappingURL=postLinkAutoRecovery.js.map