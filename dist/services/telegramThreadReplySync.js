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
exports.markTelegramCommentAnsweredInMax = markTelegramCommentAnsweredInMax;
exports.syncAdminReplyToTelegramThread = syncAdminReplyToTelegramThread;
const axios_1 = __importDefault(require("axios"));
const commentStore_1 = require("./commentStore");
const postCommentMappingStore_1 = require("./postCommentMappingStore");
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const commentSyncGuard_1 = require("../utils/commentSyncGuard");
const commentSyncFilter_1 = require("../utils/commentSyncFilter");
const logger_1 = require("../utils/logger");
const TG_API = 'https://api.telegram.org';
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
async function tryEditTelegramMessageText(token, chatId, messageId, text) {
    const { data } = await axios_1.default.post(`${TG_API}/bot${token}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
    }, { timeout: 20_000 });
    return data.ok === true;
}
async function tryEditTelegramMessageCaption(token, chatId, messageId, caption) {
    const { data } = await axios_1.default.post(`${TG_API}/bot${token}/editMessageCaption`, {
        chat_id: chatId,
        message_id: messageId,
        caption,
    }, { timeout: 20_000 });
    return data.ok === true;
}
async function trySetTelegramMessageReaction(token, chatId, messageId) {
    const { data } = await axios_1.default.post(`${TG_API}/bot${token}/setMessageReaction`, {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji: '✅' }],
    }, { timeout: 20_000 });
    return data.ok === true;
}
/**
 * Помечает исходный комментарий в TG-треде как отвеченный в MAX.
 */
async function markTelegramCommentAnsweredInMax(token, chatId, tgCommentId, commentText) {
    const guardKey = `tg-marked-max:${tgCommentId}`;
    if ((0, commentSyncGuard_1.isCommentSynced)(guardKey)) {
        return;
    }
    const baseText = commentText.trim();
    if (!baseText || (0, commentSyncFilter_1.isTelegramCommentMarkedAnsweredInMax)(baseText)) {
        (0, commentSyncGuard_1.markCommentSynced)(guardKey);
        return;
    }
    const markedText = `${baseText}\n\n${commentSyncFilter_1.MAX_ANSWERED_IN_MAX_MARKER}`;
    try {
        const edited = (await tryEditTelegramMessageText(token, chatId, tgCommentId, markedText)) ||
            (await tryEditTelegramMessageCaption(token, chatId, tgCommentId, markedText));
        if (edited) {
            (0, commentSyncGuard_1.markCommentSynced)(guardKey);
            logger_1.logger.info('[telegramThreadReplySync] marked TG comment as answered in MAX (edit)', {
                tgCommentId,
                chatId,
            });
            return;
        }
    }
    catch (err) {
        logger_1.logger.debug('[telegramThreadReplySync] edit TG comment for MAX answered mark failed', {
            tgCommentId,
            err,
        });
    }
    try {
        const reacted = await trySetTelegramMessageReaction(token, chatId, tgCommentId);
        if (reacted) {
            (0, commentSyncGuard_1.markCommentSynced)(guardKey);
            logger_1.logger.info('[telegramThreadReplySync] marked TG comment as answered in MAX (reaction)', {
                tgCommentId,
                chatId,
            });
            return;
        }
    }
    catch (err) {
        logger_1.logger.warn('[telegramThreadReplySync] setMessageReaction failed', {
            tgCommentId,
            chatId,
            err,
        });
    }
}
/**
 * Отправляет последний ответ администратора в TG-тред, если есть маппинг поста.
 */
async function syncAdminReplyToTelegramThread(_bot, comment, post) {
    const maxReply = commentStore_1.commentStore.latestMaxAdminReply(comment);
    if (!maxReply) {
        return;
    }
    const replyText = maxReply.text.trim();
    if (!replyText) {
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
    const threadChatId = mapping.tg_thread_chat_id;
    if (comment.tg_comment_id) {
        await markTelegramCommentAnsweredInMax(token, threadChatId, comment.tg_comment_id, comment.text);
    }
    if (comment.tg_thread_reply_id) {
        return;
    }
    const guardKey = `max-reply:${comment.comment_id}:${replyText}`;
    if ((0, commentSyncGuard_1.isCommentSynced)(guardKey)) {
        return;
    }
    let replyToId = mapping.tg_thread_msg_id;
    if (comment.tg_comment_id) {
        replyToId = comment.tg_comment_id;
    }
    try {
        const tgMsgId = await sendTelegramThreadMessage(token, threadChatId, `${commentSyncFilter_1.MAX_REPLY_TG_PREFIX} ${replyText}`, replyToId);
        if (tgMsgId == null) {
            return;
        }
        (0, commentSyncGuard_1.markCommentSynced)(`tg:${tgMsgId}`);
        (0, commentSyncGuard_1.markCommentSynced)(guardKey);
        commentStore_1.commentStore.setTgThreadReplyId(comment.comment_id, tgMsgId);
        logger_1.logger.info('[telegramThreadReplySync] delivered admin reply to TG thread', {
            commentId: comment.comment_id,
            tgMsgId,
            threadChatId,
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