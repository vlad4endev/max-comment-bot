"use strict";
/**
 * maxCommentSyncService.ts
 *
 * Периодически догоняет комментарии и ответы админа из MAX miniapp,
 * которые ещё не отправлены в TG discussion group.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMaxCommentSync = startMaxCommentSync;
const adminPanelState_1 = require("../api/adminPanelState");
const commentStore_1 = require("./commentStore");
const postStore_1 = require("./postStore");
const commentSyncDiagnostics_1 = require("./commentSyncDiagnostics");
const telegramThreadReplySync_1 = require("./telegramThreadReplySync");
const telegramDiscussionThreadResolver_1 = require("./telegramDiscussionThreadResolver");
const postCommentMappingStore_1 = require("./postCommentMappingStore");
const logger_1 = require("../utils/logger");
const telegramRateLimiter_1 = require("../utils/telegramRateLimiter");
const THREAD_REPAIR_PER_CYCLE = 3;
function purgeStaleUndeliverableOnStartup() {
    for (const chain of (0, adminPanelState_1.listTgChainsSync)()) {
        if (chain.forward_comments !== true) {
            continue;
        }
        const staleCount = (0, commentSyncDiagnostics_1.purgeStaleUndeliverableComments)(chain.id);
        if (staleCount > 0) {
            logger_1.logger.info('[maxCommentSync] списано безвозвратных комментариев', {
                chainId: chain.id,
                count: staleCount,
                older_than_days: commentSyncDiagnostics_1.STALE_UNDELIVERABLE_DAYS,
            });
        }
    }
}
function startMaxCommentSync(bot, options = {}) {
    const intervalMs = options.intervalMs ?? (0, telegramRateLimiter_1.getMaxCommentSyncIntervalMs)();
    const batchSize = options.batchSize ?? (0, telegramRateLimiter_1.getTelegramCommentSyncBatchSize)();
    purgeStaleUndeliverableOnStartup();
    async function repairThreadMappingsForPending(postMessageMids) {
        const unique = [...new Set(postMessageMids.filter((m) => m.trim() !== ''))];
        let repaired = 0;
        for (const messageMid of unique) {
            if (repaired >= THREAD_REPAIR_PER_CYCLE) {
                break;
            }
            const mapping = (0, postCommentMappingStore_1.findMappingByMaxMid)(messageMid);
            if (mapping?.tg_thread_chat_id && mapping.tg_thread_msg_id) {
                continue;
            }
            try {
                const result = await (0, telegramDiscussionThreadResolver_1.ensurePostThreadMapping)(messageMid);
                if (result?.tg_thread_chat_id && result.tg_thread_msg_id) {
                    repaired += 1;
                    logger_1.logger.info('[maxCommentSync] auto-repaired thread mapping', {
                        messageMid,
                        threadChatId: result.tg_thread_chat_id,
                        threadMsgId: result.tg_thread_msg_id,
                    });
                }
            }
            catch (err) {
                logger_1.logger.warn('[maxCommentSync] auto-repair thread mapping failed', { messageMid, err });
            }
        }
    }
    async function syncOnce() {
        if ((0, telegramRateLimiter_1.isTelegramApiPaused)()) {
            logger_1.logger.debug('[maxCommentSync] skipped: Telegram API pause active');
            return;
        }
        try {
            const pendingComments = commentStore_1.commentStore.listCommentsPendingMaxToTelegram(batchSize);
            const pendingReplies = commentStore_1.commentStore.listCommentsPendingTelegramThreadReply(batchSize);
            const messageMids = [];
            for (const comment of [...pendingComments, ...pendingReplies]) {
                const post = postStore_1.postStore.getPost(comment.post_id);
                if (post?.message_mid) {
                    messageMids.push(post.message_mid);
                }
            }
            if (messageMids.length > 0) {
                await repairThreadMappingsForPending(messageMids);
            }
            for (const comment of pendingComments) {
                if ((0, telegramRateLimiter_1.isTelegramApiPaused)()) {
                    break;
                }
                const post = postStore_1.postStore.getPost(comment.post_id);
                if (!post) {
                    continue;
                }
                await (0, telegramThreadReplySync_1.syncMaxCommentToTelegramThread)(bot, comment, post);
            }
            for (const comment of pendingReplies) {
                if ((0, telegramRateLimiter_1.isTelegramApiPaused)()) {
                    break;
                }
                const post = postStore_1.postStore.getPost(comment.post_id);
                if (!post) {
                    continue;
                }
                await (0, telegramThreadReplySync_1.syncAdminReplyToTelegramThread)(bot, comment, post);
            }
        }
        catch (err) {
            logger_1.logger.error('[maxCommentSync] polling error', err);
        }
    }
    const timer = setInterval(() => {
        void syncOnce();
    }, intervalMs);
    void syncOnce();
    logger_1.logger.info('[maxCommentSync] started', { intervalMs, batchSize });
    return () => clearInterval(timer);
}
//# sourceMappingURL=maxCommentSyncService.js.map