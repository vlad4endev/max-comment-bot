"use strict";
/**
 * maxCommentSyncService.ts
 *
 * Периодически догоняет комментарии и ответы админа из MAX miniapp,
 * которые ещё не отправлены в TG discussion group.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMaxCommentSync = startMaxCommentSync;
const commentStore_1 = require("./commentStore");
const postStore_1 = require("./postStore");
const telegramThreadReplySync_1 = require("./telegramThreadReplySync");
const logger_1 = require("../utils/logger");
function startMaxCommentSync(bot, options = {}) {
    const { intervalMs = 15_000 } = options;
    async function syncOnce() {
        try {
            const pendingComments = commentStore_1.commentStore.listCommentsPendingMaxToTelegram(25);
            for (const comment of pendingComments) {
                const post = postStore_1.postStore.getPost(comment.post_id);
                if (!post) {
                    continue;
                }
                await (0, telegramThreadReplySync_1.syncMaxCommentToTelegramThread)(bot, comment, post);
            }
            const pendingReplies = commentStore_1.commentStore.listCommentsPendingTelegramThreadReply(25);
            for (const comment of pendingReplies) {
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
    return () => clearInterval(timer);
}
//# sourceMappingURL=maxCommentSyncService.js.map