"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scheduleCommentButtonRetry = scheduleCommentButtonRetry;
exports.startCommentButtonRetryLoop = startCommentButtonRetryLoop;
exports.stopCommentButtonRetryLoop = stopCommentButtonRetryLoop;
exports.clearCommentButtonRetriesForChannel = clearCommentButtonRetriesForChannel;
exports.getCommentButtonRetryQueueSize = getCommentButtonRetryQueueSize;
const p_limit_1 = __importDefault(require("p-limit"));
const logger_1 = require("../utils/logger");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const channelPostActions_1 = require("./channelPostActions");
const postStore_1 = require("./postStore");
const MAX_ATTEMPTS = 10;
const RETRY_TICK_MS = 2_500;
const RETRY_CONCURRENCY = 4;
const BASE_BACKOFF_MS = 3_000;
const MAX_BACKOFF_MS = 120_000;
const queue = new Map();
let intervalId;
let botRef = null;
const limit = (0, p_limit_1.default)(RETRY_CONCURRENCY);
function queueKey(chatId, messageMid) {
    const canonical = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chatId) ?? chatId;
    return `${canonical}:${messageMid}`;
}
/**
 * Планирует повторную привязку кнопки (после attach_failed или пропущенного webhook).
 */
function scheduleCommentButtonRetry(chatId, messageMid) {
    const mid = messageMid.trim();
    if (mid === '') {
        return;
    }
    const canonical = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chatId) ?? chatId;
    if (postStore_1.postStore.findPostByChannelMessage(canonical, mid)) {
        return;
    }
    const key = queueKey(canonical, mid);
    const prev = queue.get(key);
    if (prev && prev.attempts >= MAX_ATTEMPTS) {
        return;
    }
    const nextAt = Date.now() + (prev ? Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** prev.attempts) : 1_500);
    queue.set(key, {
        chatId: canonical,
        messageMid: mid,
        attempts: prev?.attempts ?? 0,
        nextAt,
    });
    logger_1.logger.info('commentButtonRetry: scheduled', {
        chatId: canonical,
        messageMid: mid,
        attempts: prev?.attempts ?? 0,
        nextInMs: Math.max(0, nextAt - Date.now()),
        queueSize: queue.size,
    });
}
async function processOneRetry(bot, entry, key) {
    const post = await (0, channelPostActions_1.ensurePostFromChannelMessage)(bot, entry.chatId, entry.messageMid);
    if (post) {
        queue.delete(key);
        logger_1.logger.info('commentButtonRetry: success', {
            chatId: entry.chatId,
            messageMid: entry.messageMid,
            postId: post.post_id,
            attempts: entry.attempts,
        });
        return;
    }
    const attempts = entry.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
        queue.delete(key);
        logger_1.logger.warn('commentButtonRetry: giving up', {
            chatId: entry.chatId,
            messageMid: entry.messageMid,
            attempts,
        });
        return;
    }
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts);
    queue.set(key, {
        ...entry,
        attempts,
        nextAt: Date.now() + backoff,
    });
    logger_1.logger.info('commentButtonRetry: will retry', {
        chatId: entry.chatId,
        messageMid: entry.messageMid,
        attempts,
        backoffMs: backoff,
    });
}
async function drainRetryQueue(bot) {
    const now = Date.now();
    const ready = [...queue.entries()]
        .filter(([, e]) => e.nextAt <= now)
        .slice(0, 20);
    if (ready.length === 0) {
        return;
    }
    await Promise.all(ready.map(([key, entry]) => limit(() => processOneRetry(bot, entry, key))));
}
function startCommentButtonRetryLoop(bot) {
    stopCommentButtonRetryLoop();
    botRef = bot;
    void drainRetryQueue(bot);
    intervalId = setInterval(() => {
        if (!botRef) {
            return;
        }
        void drainRetryQueue(botRef).catch((err) => {
            logger_1.logger.error('commentButtonRetry: tick error', err);
        });
    }, RETRY_TICK_MS);
    logger_1.logger.info('commentButtonRetry: started', {
        tickMs: RETRY_TICK_MS,
        concurrency: RETRY_CONCURRENCY,
        maxAttempts: MAX_ATTEMPTS,
    });
}
function stopCommentButtonRetryLoop() {
    if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
    }
    botRef = null;
    logger_1.logger.info('commentButtonRetry: stopped');
}
function clearCommentButtonRetriesForChannel(chatId) {
    const abs = Math.abs((0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chatId) ?? chatId);
    for (const key of [...queue.keys()]) {
        const entry = queue.get(key);
        if (entry && Math.abs(entry.chatId) === abs) {
            queue.delete(key);
        }
    }
}
function getCommentButtonRetryQueueSize() {
    return queue.size;
}
//# sourceMappingURL=commentButtonRetryQueue.js.map