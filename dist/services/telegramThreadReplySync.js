"use strict";
/**
 * telegramThreadReplySync.ts
 *
 * MAX miniapp → TG discussion group: пользовательские комментарии и ответы админа.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.markTelegramCommentAnsweredInMax = markTelegramCommentAnsweredInMax;
exports.syncMaxCommentToTelegramThread = syncMaxCommentToTelegramThread;
exports.syncAdminReplyToTelegramThread = syncAdminReplyToTelegramThread;
const axios_1 = __importDefault(require("axios"));
const adminPanelState_1 = require("../api/adminPanelState");
const commentStore_1 = require("./commentStore");
const postCommentMappingStore_1 = require("./postCommentMappingStore");
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const commentSyncGuard_1 = require("../utils/commentSyncGuard");
const commentSyncFilter_1 = require("../utils/commentSyncFilter");
const logger_1 = require("../utils/logger");
const telegramMtprotoDiscussionSender_1 = require("./telegramMtprotoDiscussionSender");
const TG_API = 'https://api.telegram.org';
function resolveDiscussionSendAs(chainId) {
    const chain = (0, adminPanelState_1.listTgChainsSync)().find((c) => c.id === chainId);
    return chain?.tg_discussion_send_as === 'chat' ? 'chat' : 'channel';
}
function resolveTelegramBotTokenForChain(chainId) {
    const chain = (0, adminPanelState_1.listTgChainsSync)().find((c) => c.id === chainId);
    const fromChain = chain?.bot_token?.trim();
    if (fromChain) {
        return fromChain;
    }
    return (0, resolveTelegramBotToken_1.resolveTelegramBotToken)();
}
function isCommentForwardEnabled(chainId) {
    const chain = (0, adminPanelState_1.listTgChainsSync)().find((c) => c.id === chainId);
    return chain?.active !== false && chain?.forward_comments === true;
}
function resolveChannelKeyForMapping(mapping) {
    const chain = (0, adminPanelState_1.listTgChainsSync)().find((c) => c.id === mapping.chain_id);
    const fromChainId = chain?.tg_channel_id?.trim();
    if (fromChainId) {
        return fromChainId;
    }
    const username = chain?.tg_username?.trim();
    if (username) {
        return username.startsWith('@') ? username : `@${username}`;
    }
    if (typeof mapping.tg_chat_id === 'number') {
        return String(mapping.tg_chat_id);
    }
    return null;
}
function resolvePostThreadTarget(messageMid) {
    const mapping = (0, postCommentMappingStore_1.findMappingByMaxMid)(messageMid);
    if (!mapping?.tg_thread_chat_id || !mapping.tg_thread_msg_id) {
        return null;
    }
    if (!isCommentForwardEnabled(mapping.chain_id)) {
        return null;
    }
    const token = resolveTelegramBotTokenForChain(mapping.chain_id);
    if (!token) {
        return null;
    }
    return {
        chainId: mapping.chain_id,
        token,
        threadChatId: mapping.tg_thread_chat_id,
        threadMsgId: mapping.tg_thread_msg_id,
        channelKey: resolveChannelKeyForMapping(mapping),
        sendAsMode: resolveDiscussionSendAs(mapping.chain_id),
    };
}
function buildMaxCommentTelegramText(comment, asChannel) {
    const text = comment.text.trim();
    const photoFallback = '📷 Фото';
    if (asChannel) {
        if (text) {
            return text;
        }
        if (Array.isArray(comment.photo_urls) && comment.photo_urls.length > 0) {
            return photoFallback;
        }
        return '';
    }
    if (text) {
        return (0, commentSyncFilter_1.formatMaxCommentForTelegram)(comment.username, text);
    }
    if (Array.isArray(comment.photo_urls) && comment.photo_urls.length > 0) {
        return (0, commentSyncFilter_1.formatMaxCommentForTelegram)(comment.username, photoFallback);
    }
    return '';
}
async function deliverTelegramThreadMessage(target, text, replyToId, useMtprotoSendAs, botFallbackText) {
    if (useMtprotoSendAs && (target.sendAsMode === 'chat' || target.channelKey)) {
        try {
            const tgMsgId = await (0, telegramMtprotoDiscussionSender_1.sendDiscussionMessageAsPeer)(target.sendAsMode, target.threadChatId, target.channelKey, text, replyToId);
            if (tgMsgId != null) {
                return tgMsgId;
            }
            logger_1.logger.warn('[telegramThreadReplySync] sendAs peer unavailable, fallback to bot', {
                chainId: target.chainId,
                sendAsMode: target.sendAsMode,
                channelKey: target.channelKey,
            });
        }
        catch (err) {
            logger_1.logger.warn('[telegramThreadReplySync] sendAs peer failed, fallback to bot', {
                chainId: target.chainId,
                sendAsMode: target.sendAsMode,
                channelKey: target.channelKey,
                err,
            });
        }
    }
    const botText = botFallbackText ?? text;
    return sendTelegramThreadMessage(target.token, target.threadChatId, botText, replyToId);
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
 * Отправляет пользовательский комментарий из MAX miniapp в TG-тред.
 */
async function syncMaxCommentToTelegramThread(_bot, comment, post) {
    const freshComment = commentStore_1.commentStore.getComment(comment.comment_id) ?? comment;
    if (freshComment.source === 'telegram' || freshComment.tg_comment_id) {
        return;
    }
    const target = resolvePostThreadTarget(post.message_mid);
    if (!target) {
        logger_1.logger.warn('[telegramThreadReplySync] no thread mapping for MAX comment', {
            commentId: freshComment.comment_id,
            messageMid: post.message_mid,
        });
        return;
    }
    const postAsPeer = freshComment.posted_as_channel === true;
    const body = buildMaxCommentTelegramText(freshComment, postAsPeer);
    if (!body) {
        return;
    }
    const guardKey = `max-comment:${freshComment.comment_id}`;
    if ((0, commentSyncGuard_1.isCommentSynced)(guardKey)) {
        return;
    }
    try {
        const tgMsgId = await deliverTelegramThreadMessage(target, body, target.threadMsgId, postAsPeer, postAsPeer ? (0, commentSyncFilter_1.formatMaxCommentForTelegram)(freshComment.username, body) : undefined);
        if (tgMsgId == null) {
            return;
        }
        (0, commentSyncGuard_1.markCommentSynced)(`tg:${tgMsgId}`);
        (0, commentSyncGuard_1.markCommentSynced)(guardKey);
        commentStore_1.commentStore.setTgCommentId(freshComment.comment_id, tgMsgId);
        logger_1.logger.info('[telegramThreadReplySync] delivered MAX comment to TG thread', {
            commentId: freshComment.comment_id,
            tgMsgId,
            threadChatId: target.threadChatId,
            username: freshComment.username,
        });
    }
    catch (err) {
        logger_1.logger.warn('[telegramThreadReplySync] send MAX comment failed', {
            commentId: freshComment.comment_id,
            threadChatId: target.threadChatId,
            err,
        });
    }
}
/**
 * Отправляет последний ответ администратора в TG-тред, если есть маппинг поста.
 */
async function syncAdminReplyToTelegramThread(_bot, comment, post) {
    const freshComment = commentStore_1.commentStore.getComment(comment.comment_id) ?? comment;
    const maxReply = commentStore_1.commentStore.latestMaxAdminReply(freshComment);
    if (!maxReply) {
        return;
    }
    const replyText = maxReply.text.trim();
    if (!replyText) {
        return;
    }
    const target = resolvePostThreadTarget(post.message_mid);
    if (!target) {
        const mapping = (0, postCommentMappingStore_1.findMappingByMaxMid)(post.message_mid);
        logger_1.logger.warn('[telegramThreadReplySync] no thread mapping for post', {
            commentId: freshComment.comment_id,
            messageMid: post.message_mid,
            chainId: mapping?.chain_id ?? null,
            tgThreadChatId: mapping?.tg_thread_chat_id ?? null,
            tgThreadMsgId: mapping?.tg_thread_msg_id ?? null,
        });
        return;
    }
    const { token, threadChatId, threadMsgId: mappingThreadMsgId } = target;
    if (freshComment.tg_comment_id) {
        await markTelegramCommentAnsweredInMax(token, threadChatId, freshComment.tg_comment_id, freshComment.text);
    }
    if (freshComment.tg_thread_reply_id) {
        return;
    }
    const guardKey = `max-reply:${freshComment.comment_id}:${replyText}`;
    if ((0, commentSyncGuard_1.isCommentSynced)(guardKey)) {
        return;
    }
    let replyToId = mappingThreadMsgId;
    if (freshComment.tg_comment_id) {
        replyToId = freshComment.tg_comment_id;
    }
    try {
        const tgMsgId = await deliverTelegramThreadMessage(target, replyText, replyToId, true, `${commentSyncFilter_1.MAX_REPLY_TG_PREFIX} ${replyText}`);
        if (tgMsgId == null) {
            return;
        }
        (0, commentSyncGuard_1.markCommentSynced)(`tg:${tgMsgId}`);
        (0, commentSyncGuard_1.markCommentSynced)(guardKey);
        commentStore_1.commentStore.setTgThreadReplyId(freshComment.comment_id, tgMsgId);
        logger_1.logger.info('[telegramThreadReplySync] delivered admin reply to TG thread', {
            commentId: freshComment.comment_id,
            tgMsgId,
            threadChatId,
            replyToId,
        });
    }
    catch (err) {
        logger_1.logger.warn('[telegramThreadReplySync] sendMessage failed', {
            commentId: freshComment.comment_id,
            threadChatId,
            replyToId,
            err,
        });
    }
}
//# sourceMappingURL=telegramThreadReplySync.js.map