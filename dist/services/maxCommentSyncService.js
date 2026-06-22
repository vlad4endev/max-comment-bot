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
const database_1 = require("../db/database");
const commentStore_1 = require("./commentStore");
const postStore_1 = require("./postStore");
const commentSyncDiagnostics_1 = require("./commentSyncDiagnostics");
const telegramThreadReplySync_1 = require("./telegramThreadReplySync");
const telegramDiscussionThreadResolver_1 = require("./telegramDiscussionThreadResolver");
const postCommentMappingStore_1 = require("./postCommentMappingStore");
const logger_1 = require("../utils/logger");
const alertService_1 = require("../utils/alertService");
const telegramRateLimiter_1 = require("../utils/telegramRateLimiter");
const THREAD_REPAIR_PER_CYCLE = 3;
const BOOTSTRAP_REPAIR_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const HOURLY_REPAIR_MS = 60 * 60 * 1000;
const DAILY_STALE_PURGE_MS = 24 * 60 * 60 * 1000;
function countPendingCommentsForChain(chainId) {
    const row = (0, database_1.getDb)()
        .prepare(`SELECT COUNT(*) AS n FROM comments c
       JOIN posts p ON p.post_id = c.post_id
       LEFT JOIN post_comment_mapping m ON m.max_mid = p.message_mid AND m.chain_id = ?
       WHERE (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)
         AND (c.source IS NULL OR c.source = 'max')
         AND (m.tg_thread_msg_id IS NULL OR m.tg_thread_msg_id = 0)`)
        .get(chainId);
    return Number(row.n) || 0;
}
async function repairThreadMappings(chainId, posts) {
    let repaired = 0;
    for (const post of posts) {
        const messageMid = post.message_mid.trim();
        if (!messageMid) {
            continue;
        }
        const mapping = (0, postCommentMappingStore_1.findMappingByMaxMid)(messageMid);
        if (mapping?.tg_thread_chat_id && mapping.tg_thread_msg_id) {
            continue;
        }
        try {
            const result = await (0, telegramDiscussionThreadResolver_1.ensurePostThreadMapping)(messageMid);
            if (result?.tg_thread_chat_id && result.tg_thread_msg_id) {
                repaired += 1;
                logger_1.logger.info('[maxCommentSync] bootstrap: repaired thread mapping', {
                    chainId,
                    messageMid,
                    threadChatId: result.tg_thread_chat_id,
                    threadMsgId: result.tg_thread_msg_id,
                });
            }
        }
        catch (err) {
            logger_1.logger.warn('[maxCommentSync] bootstrap: repair thread mapping failed', {
                chainId,
                messageMid,
                err,
            });
        }
    }
    if (repaired > 0) {
        logger_1.logger.info('[maxCommentSync] bootstrap: repair batch finished', {
            chainId,
            attempted: posts.length,
            repaired,
        });
    }
}
async function bootstrapRepairOnStartup() {
    const db = (0, database_1.getDb)();
    const chains = (0, adminPanelState_1.listTgChainsSync)().filter((c) => c.active && c.forward_comments);
    const lookbackIso = new Date(Date.now() - BOOTSTRAP_REPAIR_LOOKBACK_MS).toISOString();
    for (const chain of chains) {
        const postsNeedRepair = db
            .prepare(`SELECT DISTINCT p.message_mid, m.tg_msg_id
         FROM comments c
         JOIN posts p ON p.post_id = c.post_id
         JOIN post_comment_mapping m ON m.max_mid = p.message_mid AND m.chain_id = ?
         WHERE (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)
           AND (c.source IS NULL OR c.source = 'max')
           AND (m.tg_thread_msg_id IS NULL OR m.tg_thread_msg_id = 0)
           AND p.timestamp > ?
         LIMIT 50`)
            .all(chain.id, lookbackIso);
        if (postsNeedRepair.length > 0) {
            logger_1.logger.info('[maxCommentSync] bootstrap: repairing threads for pending comments', {
                chainId: chain.id,
                count: postsNeedRepair.length,
            });
            await repairThreadMappings(chain.id, postsNeedRepair);
        }
        const pendingCount = countPendingCommentsForChain(chain.id);
        if (pendingCount > 100) {
            await (0, alertService_1.sendAdminAlert)('comments_pending', `${pendingCount} комментариев не синхронизированы`, { chainId: chain.id, pendingCount });
        }
    }
}
function purgeStaleUndeliverableOnStartup() {
    for (const chain of (0, adminPanelState_1.listTgChainsSync)()) {
        if (chain.forward_comments !== true) {
            continue;
        }
        const staleCount = (0, commentSyncDiagnostics_1.purgeStaleUndeliverableComments)(chain.id);
        if (staleCount > 0) {
            logger_1.logger.info('[maxCommentSync] purged stale undeliverable comments', {
                chainId: chain.id,
                count: staleCount,
                older_than_days: commentSyncDiagnostics_1.STALE_UNDELIVERABLE_DAYS,
            });
        }
    }
}
function purgeStaleUndeliverableDaily() {
    const staleCutoff = (0, commentSyncDiagnostics_1.staleUndeliverableCutoffIso)();
    for (const chain of (0, adminPanelState_1.listTgChainsSync)()) {
        if (chain.forward_comments !== true) {
            continue;
        }
        const result = (0, database_1.getDb)()
            .prepare(`UPDATE comments
         SET tg_comment_id = -(strftime('%s', 'now') * 1000 + ABS(RANDOM() % 1000))
         WHERE rowid IN (
           SELECT c.rowid FROM comments c
           JOIN posts p ON p.post_id = c.post_id
           LEFT JOIN post_comment_mapping m ON m.max_mid = p.message_mid AND m.chain_id = ?
           WHERE (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)
             AND (c.source IS NULL OR c.source = 'max')
             AND (m.tg_thread_msg_id IS NULL OR m.tg_thread_msg_id = 0)
             AND p.timestamp < ?
           LIMIT 500
         )`)
            .run(chain.id, staleCutoff);
        const count = Number(result.changes) || 0;
        if (count > 0) {
            logger_1.logger.info('[maxCommentSync] daily stale comment write-off', {
                chainId: chain.id,
                count,
                older_than_days: commentSyncDiagnostics_1.STALE_UNDELIVERABLE_DAYS,
            });
        }
    }
}
function startMaxCommentSync(bot, options = {}) {
    const intervalMs = options.intervalMs ?? (0, telegramRateLimiter_1.getMaxCommentSyncIntervalMs)();
    const batchSize = options.batchSize ?? (0, telegramRateLimiter_1.getTelegramCommentSyncBatchSize)();
    purgeStaleUndeliverableOnStartup();
    void bootstrapRepairOnStartup().catch((err) => {
        logger_1.logger.warn('[maxCommentSync] bootstrap repair error', { err });
    });
    const hourlyRepairTimer = setInterval(() => {
        void bootstrapRepairOnStartup().catch((err) => {
            logger_1.logger.warn('[maxCommentSync] periodic repair error', { err });
        });
    }, HOURLY_REPAIR_MS);
    const dailyStaleTimer = setInterval(() => {
        try {
            purgeStaleUndeliverableDaily();
        }
        catch (err) {
            logger_1.logger.warn('[maxCommentSync] daily stale purge error', { err });
        }
    }, DAILY_STALE_PURGE_MS);
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
            for (const chain of (0, adminPanelState_1.listTgChainsSync)()) {
                if (!chain.active || !chain.forward_comments) {
                    continue;
                }
                const pendingCount = countPendingCommentsForChain(chain.id);
                if (pendingCount > 100) {
                    await (0, alertService_1.sendAdminAlert)('comments_pending', `${pendingCount} комментариев не синхронизированы`, { chainId: chain.id, pendingCount });
                }
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
    return () => {
        clearInterval(timer);
        clearInterval(hourlyRepairTimer);
        clearInterval(dailyStaleTimer);
    };
}
//# sourceMappingURL=maxCommentSyncService.js.map