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
const telegramDiscussionThreadResolver_1 = require("./telegramDiscussionThreadResolver");
const postStore_1 = require("./postStore");
const resolveTelegramBotToken_1 = require("./resolveTelegramBotToken");
const commentSyncGuard_1 = require("../utils/commentSyncGuard");
const commentSyncFilter_1 = require("../utils/commentSyncFilter");
const commentsBookingService_1 = require("./commentsBookingService");
const logger_1 = require("../utils/logger");
const telegramSyncErrors_1 = require("../utils/telegramSyncErrors");
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
function resolvePostThreadTargetFromMapping(mapping) {
    if (!mapping.tg_thread_chat_id || !mapping.tg_thread_msg_id) {
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
async function resolvePostThreadTarget(messageMid) {
    await (0, telegramDiscussionThreadResolver_1.ensurePostThreadMapping)(messageMid);
    const mapping = (0, postCommentMappingStore_1.findMappingByMaxMid)(messageMid);
    if (!mapping) {
        return null;
    }
    return resolvePostThreadTargetFromMapping(mapping);
}
function buildMaxCommentTelegramText(comment) {
    const stored = comment.tg_message_text?.trim();
    if (stored) {
        return stored;
    }
    const text = comment.text.trim();
    const photoFallback = '📷 Фото';
    const name = comment.username.trim() || 'Пользователь';
    if (text) {
        return (0, commentSyncFilter_1.formatMaxCommentForTelegram)(name, text);
    }
    if (Array.isArray(comment.photo_urls) && comment.photo_urls.length > 0) {
        return (0, commentSyncFilter_1.formatMaxCommentForTelegram)(name, photoFallback);
    }
    return '';
}
function tgPayload(target, extra) {
    const payload = {
        chat_id: target.chatId,
        message_id: target.messageId,
        ...extra,
    };
    if (typeof target.messageThreadId === 'number' && target.messageThreadId > 0) {
        payload.message_thread_id = target.messageThreadId;
    }
    return payload;
}
async function callTelegramBot(token, method, payload, logContext) {
    const { data } = await axios_1.default.post(`${TG_API}/bot${token}/${method}`, payload, {
        timeout: 20_000,
    });
    if (!data.ok) {
        const description = data.description ?? '';
        logger_1.logger.warn(`[telegramThreadReplySync] ${method} failed`, {
            ...logContext,
            description,
            errorKind: (0, telegramSyncErrors_1.isInvalidTelegramMessageIdError)(description)
                ? 'invalid_message_id'
                : (0, telegramSyncErrors_1.isTelegramForbiddenError)(description)
                    ? 'forbidden'
                    : 'other',
            suggestion: (0, telegramSyncErrors_1.suggestActionForTelegramSyncError)(description),
        });
    }
    return data;
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
            const errText = (0, telegramSyncErrors_1.extractTelegramErrorText)(err);
            logger_1.logger.warn('[telegramThreadReplySync] sendAs peer failed, fallback to bot', {
                chainId: target.chainId,
                sendAsMode: target.sendAsMode,
                channelKey: target.channelKey,
                err,
                errorKind: (0, telegramSyncErrors_1.isSendAsPeerInvalidError)(errText) ? 'send_as_peer_invalid' : 'other',
                suggestion: (0, telegramSyncErrors_1.suggestActionForTelegramSyncError)(errText),
            });
        }
    }
    const botText = botFallbackText ?? text;
    return sendTelegramThreadMessage(target.token, target.threadChatId, botText, replyToId, target.threadMsgId);
}
async function sendTelegramThreadMessage(token, chatId, text, replyToMessageId, messageThreadId) {
    const payload = {
        chat_id: chatId,
        text,
        reply_to_message_id: replyToMessageId,
    };
    if (typeof messageThreadId === 'number' && messageThreadId > 0) {
        payload.message_thread_id = messageThreadId;
    }
    const data = await callTelegramBot(token, 'sendMessage', payload, { chatId, replyToMessageId, messageThreadId });
    if (!data.ok) {
        throw new Error(data.description ?? 'Telegram sendMessage failed');
    }
    const messageId = data.result?.message_id;
    return typeof messageId === 'number' ? messageId : null;
}
async function deliverTelegramThreadMessageWithRetry(messageMid, target, text, replyToId, useMtprotoSendAs, botFallbackText) {
    try {
        return await deliverTelegramThreadMessage(target, text, replyToId, useMtprotoSendAs, botFallbackText);
    }
    catch (err) {
        const errText = (0, telegramSyncErrors_1.extractTelegramErrorText)(err);
        if (!(0, telegramSyncErrors_1.isInvalidTelegramMessageIdError)(errText)) {
            throw err;
        }
        logger_1.logger.warn('[telegramThreadReplySync] invalid thread message id, refreshing mapping', {
            messageMid,
            chainId: target.chainId,
            threadChatId: target.threadChatId,
            threadMsgId: target.threadMsgId,
            replyToId,
            errText,
        });
        const refreshed = await (0, telegramDiscussionThreadResolver_1.refreshPostThreadMapping)(messageMid);
        const refreshedTarget = refreshed ? resolvePostThreadTargetFromMapping(refreshed) : null;
        if (!refreshedTarget) {
            throw err;
        }
        return deliverTelegramThreadMessage(refreshedTarget, text, refreshedTarget.threadMsgId, useMtprotoSendAs, botFallbackText);
    }
}
async function tryEditTelegramMessageText(target, text) {
    const data = await callTelegramBot(target.token, 'editMessageText', tgPayload(target, { text }), { chatId: target.chatId, messageId: target.messageId });
    return data.ok === true;
}
async function tryEditTelegramMessageCaption(target, caption) {
    const data = await callTelegramBot(target.token, 'editMessageCaption', tgPayload(target, { caption }), { chatId: target.chatId, messageId: target.messageId });
    return data.ok === true;
}
async function tryEditTelegramMessageReplyMarkup(target) {
    const data = await callTelegramBot(target.token, 'editMessageReplyMarkup', tgPayload(target, {
        reply_markup: {
            inline_keyboard: [[{ text: commentSyncFilter_1.MAX_ANSWERED_IN_MAX_MARKER, callback_data: 'max:booked' }]],
        },
    }), { chatId: target.chatId, messageId: target.messageId });
    return data.ok === true;
}
async function trySetTelegramMessageReaction(target, emoji) {
    const data = await callTelegramBot(target.token, 'setMessageReaction', tgPayload(target, {
        reaction: [{ type: 'emoji', emoji }],
    }), { chatId: target.chatId, messageId: target.messageId, emoji });
    return data.ok === true;
}
async function trySendBookedMarkerReply(token, chatId, replyToMessageId, messageThreadId) {
    const payload = {
        chat_id: chatId,
        text: commentSyncFilter_1.MAX_ANSWERED_IN_MAX_MARKER,
        reply_to_message_id: replyToMessageId,
    };
    if (typeof messageThreadId === 'number' && messageThreadId > 0) {
        payload.message_thread_id = messageThreadId;
    }
    const data = await callTelegramBot(token, 'sendMessage', payload, { chatId, replyToMessageId, messageThreadId });
    return data.ok === true;
}
async function tryEditTelegramPostBody(target, markedText) {
    return ((await tryEditTelegramMessageCaption(target, markedText)) ||
        (await tryEditTelegramMessageText(target, markedText)));
}
/**
 * Помечает исходный комментарий в TG-треде как отвеченный в MAX.
 * @returns true если сообщение успешно помечено (edit или reaction)
 */
async function markTelegramCommentAnsweredInMax(token, chatId, tgCommentId, commentText, options) {
    if (options?.commentId) {
        const existing = commentStore_1.commentStore.getComment(options.commentId);
        if (existing?.booked_in_max_tg) {
            return true;
        }
    }
    const target = {
        token,
        chatId,
        messageId: tgCommentId,
        messageThreadId: options?.messageThreadId,
    };
    const baseText = commentText.trim();
    if (!baseText) {
        logger_1.logger.warn('[telegramThreadReplySync] empty TG message text for booked marker', {
            tgCommentId,
            chatId,
            commentId: options?.commentId ?? null,
        });
        return false;
    }
    if ((0, commentSyncFilter_1.isTelegramCommentMarkedAnsweredInMax)(baseText)) {
        if (options?.commentId) {
            commentStore_1.commentStore.markBookedInMaxTelegram(options.commentId);
        }
        return true;
    }
    const markedText = `${baseText}\n\n${commentSyncFilter_1.MAX_ANSWERED_IN_MAX_MARKER}`;
    const edited = (await tryEditTelegramMessageText(target, markedText)) ||
        (await tryEditTelegramMessageCaption(target, markedText));
    if (edited) {
        logger_1.logger.info('[telegramThreadReplySync] marked TG comment as answered in MAX (edit)', {
            tgCommentId,
            chatId,
        });
        if (options?.commentId) {
            commentStore_1.commentStore.markBookedInMaxTelegram(options.commentId);
        }
        return true;
    }
    if (await tryEditTelegramMessageReplyMarkup(target)) {
        logger_1.logger.info('[telegramThreadReplySync] marked TG comment as answered in MAX (reply markup)', {
            tgCommentId,
            chatId,
        });
        if (options?.commentId) {
            commentStore_1.commentStore.markBookedInMaxTelegram(options.commentId);
        }
        return true;
    }
    for (const emoji of ['✅', '👍', '🔒']) {
        if (await trySetTelegramMessageReaction(target, emoji)) {
            logger_1.logger.info('[telegramThreadReplySync] marked TG comment as answered in MAX (reaction)', {
                tgCommentId,
                chatId,
                emoji,
            });
            if (options?.commentId) {
                commentStore_1.commentStore.markBookedInMaxTelegram(options.commentId);
            }
            return true;
        }
    }
    if (await trySendBookedMarkerReply(token, chatId, tgCommentId, options?.messageThreadId)) {
        logger_1.logger.info('[telegramThreadReplySync] marked TG comment as answered in MAX (reply marker)', {
            tgCommentId,
            chatId,
        });
        if (options?.commentId) {
            commentStore_1.commentStore.markBookedInMaxTelegram(options.commentId);
        }
        return true;
    }
    logger_1.logger.warn('[telegramThreadReplySync] failed to mark TG comment as answered in MAX', {
        tgCommentId,
        chatId,
        commentId: options?.commentId ?? null,
    });
    return false;
}
/**
 * Отправляет пользовательский комментарий из MAX miniapp в TG-тред.
 */
async function syncMaxCommentToTelegramThread(_bot, comment, post) {
    const freshPost = postStore_1.postStore.getPost(post.post_id) ?? post;
    if ((0, commentsBookingService_1.isCommentSyncBlockedByBooking)(freshPost.comments_booked_by, 'max')) {
        (0, commentSyncGuard_1.markCommentSynced)(`max-comment-tg-blocked:${comment.comment_id}`);
        logger_1.logger.debug('[telegramThreadReplySync] skip MAX→TG: post booked elsewhere', {
            commentId: comment.comment_id,
            postId: freshPost.post_id,
            bookedBy: freshPost.comments_booked_by,
        });
        return;
    }
    await (0, telegramDiscussionThreadResolver_1.ensurePostThreadMapping)(post.message_mid);
    const freshComment = commentStore_1.commentStore.getComment(comment.comment_id) ?? comment;
    if (freshComment.source === 'telegram' || freshComment.source === 'vk' || freshComment.tg_comment_id) {
        return;
    }
    const target = await resolvePostThreadTarget(post.message_mid);
    if (!target) {
        logger_1.logger.warn('[telegramThreadReplySync] no thread mapping for MAX comment', {
            commentId: freshComment.comment_id,
            messageMid: post.message_mid,
        });
        return;
    }
    const body = buildMaxCommentTelegramText(freshComment);
    if (!body) {
        return;
    }
    const guardKey = `max-comment:${freshComment.comment_id}`;
    if ((0, commentSyncGuard_1.isCommentSynced)(guardKey)) {
        return;
    }
    try {
        const tgMsgId = await deliverTelegramThreadMessageWithRetry(post.message_mid, target, body, target.threadMsgId, false);
        if (tgMsgId == null) {
            return;
        }
        (0, commentSyncGuard_1.markCommentSynced)(`tg:${tgMsgId}`);
        (0, commentSyncGuard_1.markCommentSynced)(guardKey);
        commentStore_1.commentStore.setTgCommentId(freshComment.comment_id, tgMsgId, body);
        await (0, commentsBookingService_1.claimAndPropagateCommentsBooking)(freshPost.post_id, 'max', _bot);
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
 * Отправляет ответ администратора из MAX в TG-тред только если комментарий
 * не привязан к TG (fallback). Для MAX→TG комментариев — только правка маркера.
 */
async function syncAdminReplyToTelegramThread(_bot, comment, post) {
    const freshPost = postStore_1.postStore.getPost(post.post_id) ?? post;
    if ((0, commentsBookingService_1.isCommentSyncBlockedByBooking)(freshPost.comments_booked_by, 'max')) {
        logger_1.logger.debug('[telegramThreadReplySync] skip admin MAX→TG: post booked elsewhere', {
            commentId: comment.comment_id,
            postId: freshPost.post_id,
            bookedBy: freshPost.comments_booked_by,
        });
        return;
    }
    const freshComment = commentStore_1.commentStore.getComment(comment.comment_id) ?? comment;
    const maxReply = commentStore_1.commentStore.latestMaxAdminReply(freshComment);
    if (!maxReply) {
        return;
    }
    const replyText = maxReply.text.trim();
    if (!replyText) {
        return;
    }
    if (freshComment.tg_thread_reply_id) {
        return;
    }
    const guardKey = `max-reply:${freshComment.comment_id}:${replyText}`;
    if ((0, commentSyncGuard_1.isCommentSynced)(guardKey)) {
        return;
    }
    if (freshComment.booked_in_max_tg) {
        (0, commentSyncGuard_1.markCommentSynced)(guardKey);
        commentStore_1.commentStore.markTelegramThreadReplyHandled(freshComment.comment_id);
        return;
    }
    const target = await resolvePostThreadTarget(post.message_mid);
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
    const { token, threadChatId } = target;
    // TG→MAX / VK→MAX: ответы идут только в miniapp, в Telegram ничего не отправляем.
    if (freshComment.source === 'telegram' || freshComment.source === 'vk') {
        (0, commentSyncGuard_1.markCommentSynced)(guardKey);
        commentStore_1.commentStore.markTelegramThreadReplyHandled(freshComment.comment_id);
        logger_1.logger.info('[telegramThreadReplySync] skipped outbound TG reply for TG-origin comment', {
            commentId: freshComment.comment_id,
        });
        return;
    }
    // MAX→TG: сначала убедимся, что комментарий уже в TG-треде.
    let commentForMark = commentStore_1.commentStore.getComment(freshComment.comment_id) ?? freshComment;
    if (!commentForMark.tg_comment_id) {
        await syncMaxCommentToTelegramThread(_bot, commentForMark, post);
        commentForMark = commentStore_1.commentStore.getComment(freshComment.comment_id) ?? commentForMark;
    }
    // MAX→TG: правим исходное сообщение, текст ответа в TG не отправляем.
    if (commentForMark.tg_comment_id) {
        const tgMessageText = buildMaxCommentTelegramText(commentForMark);
        const marked = await markTelegramCommentAnsweredInMax(token, threadChatId, commentForMark.tg_comment_id, tgMessageText, {
            messageThreadId: target.threadMsgId,
            commentId: commentForMark.comment_id,
        });
        if (marked) {
            (0, commentSyncGuard_1.markCommentSynced)(guardKey);
            commentStore_1.commentStore.markTelegramThreadReplyHandled(freshComment.comment_id);
            logger_1.logger.info('[telegramThreadReplySync] marked MAX comment as booked in MAX (TG edit only)', {
                commentId: freshComment.comment_id,
                tgCommentId: commentForMark.tg_comment_id,
                threadChatId,
            });
        }
        else {
            logger_1.logger.warn('[telegramThreadReplySync] could not mark MAX comment in TG thread', {
                commentId: freshComment.comment_id,
                tgCommentId: commentForMark.tg_comment_id,
                threadChatId,
            });
        }
        return;
    }
    const { threadMsgId: mappingThreadMsgId } = target;
    let replyToId = mappingThreadMsgId;
    try {
        const tgMsgId = await deliverTelegramThreadMessageWithRetry(post.message_mid, target, replyText, replyToId, true, `${commentSyncFilter_1.MAX_REPLY_TG_PREFIX} ${replyText}`);
        if (tgMsgId == null) {
            return;
        }
        (0, commentSyncGuard_1.markCommentSynced)(`tg:${tgMsgId}`);
        (0, commentSyncGuard_1.markCommentSynced)(guardKey);
        commentStore_1.commentStore.setTgThreadReplyId(freshComment.comment_id, tgMsgId);
        logger_1.logger.info('[telegramThreadReplySync] delivered admin reply to TG thread (fallback)', {
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