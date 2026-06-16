"use strict";
/**
 * telegramThreadReplySync.ts
 *
 * Ответ администратора в Max miniapp → сообщение в TG discussion group.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.syncAdminReplyToTelegramThread = syncAdminReplyToTelegramThread;
const axios_1 = __importDefault(require("axios"));
const commentStore_1 = require("./commentStore");
const postCommentMappingStore_1 = require("./postCommentMappingStore");
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const commentSyncGuard_1 = require("../utils/commentSyncGuard");
const commentSyncFilter_1 = require("../utils/commentSyncFilter");
const logger_1 = require("../utils/logger");
const TG_API = 'https://api.telegram.org';
function latestAdminReplyText(comment) {
    if (Array.isArray(comment.replies) && comment.replies.length > 0) {
        const last = comment.replies[comment.replies.length - 1];
        return last.text.trim() || null;
    }
    if (comment.reply?.text?.trim()) {
        return comment.reply.text.trim();
    }
    return null;
}
async function sendTelegramThreadMessage(token, chatId, text, replyToMessageId) {
    const { data } = await axios_1.default.post(`${TG_API}/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        reply_to_message_id: replyToMessageId,
    }, { timeout: 20_000 });
    if (!data.ok) {
        throw new Error(data.description ?? 'Telegram sendMessage failed');
    }
    const messageId = data.result?.message_id;
    return typeof messageId === 'number' ? messageId : null;
}
/**
 * Отправляет последний ответ администратора в TG-тред, если есть маппинг поста.
 */
async function syncAdminReplyToTelegramThread(_bot, comment, post) {
    if (comment.source === 'telegram') {
        return;
    }
    if (comment.tg_thread_reply_id) {
        return;
    }
    const replyText = latestAdminReplyText(comment);
    if (!replyText) {
        return;
    }
    const guardKey = `max-reply:${comment.comment_id}:${replyText}`;
    if ((0, commentSyncGuard_1.isCommentSynced)(guardKey)) {
        return;
    }
    const mapping = (0, postCommentMappingStore_1.findMappingByMaxMid)(post.message_mid);
    if (!mapping?.tg_thread_chat_id || !mapping.tg_thread_msg_id) {
        logger_1.logger.debug('[telegramThreadReplySync] no thread mapping for post', {
            commentId: comment.comment_id,
            messageMid: post.message_mid,
        });
        return;
    }
    const token = (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
    if (!token) {
        return;
    }
    let replyToId = mapping.tg_thread_msg_id;
    if (comment.tg_comment_id) {
        replyToId = comment.tg_comment_id;
    }
    try {
        const tgMsgId = await sendTelegramThreadMessage(token, mapping.tg_thread_chat_id, `${commentSyncFilter_1.MAX_REPLY_TG_PREFIX} ${replyText}`, replyToId);
        if (tgMsgId == null) {
            return;
        }
        (0, commentSyncGuard_1.markCommentSynced)(`tg:${tgMsgId}`);
        (0, commentSyncGuard_1.markCommentSynced)(guardKey);
        commentStore_1.commentStore.setTgThreadReplyId(comment.comment_id, tgMsgId);
        logger_1.logger.info('[telegramThreadReplySync] delivered admin reply to TG thread', {
            commentId: comment.comment_id,
            tgMsgId,
            threadChatId: mapping.tg_thread_chat_id,
        });
    }
    catch (err) {
        logger_1.logger.warn('[telegramThreadReplySync] sendMessage failed', {
            commentId: comment.comment_id,
            err,
        });
    }
}
//# sourceMappingURL=telegramThreadReplySync.js.map