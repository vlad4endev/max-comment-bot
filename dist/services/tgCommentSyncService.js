"use strict";
/**
 * tgCommentSyncService.ts
 *
 * Слушает новые сообщения из TG-треда обсуждения канала
 * и записывает их как комментарии в miniapp БД Max.
 *
 * Подключается к существующему polling-циклу tgChainForwarder.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDiscussionAutoForward = isDiscussionAutoForward;
exports.handleDiscussionAutoForward = handleDiscussionAutoForward;
exports.handleTgComment = handleTgComment;
const commentStore_1 = require("./commentStore");
const notificationService_1 = require("./notificationService");
const telegramAdminNotificationService_1 = require("./telegramAdminNotificationService");
const channelRegistry_1 = require("./channelRegistry");
const postCommentMappingStore_1 = require("./postCommentMappingStore");
const postStore_1 = require("./postStore");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const commentSyncGuard_1 = require("../utils/commentSyncGuard");
const commentSyncFilter_1 = require("../utils/commentSyncFilter");
const logger_1 = require("../utils/logger");
function isDiscussionAutoForward(message) {
    return Boolean(message.is_automatic_forward ||
        message.forward_origin?.type === 'channel' ||
        (message.sender_chat && message.forward_from_message_id != null));
}
/**
 * Связывает авто-репост канала в discussion group с post_comment_mapping.
 */
function handleDiscussionAutoForward(message, chainId) {
    const channelMsgId = message.forward_origin?.message_id ?? message.forward_from_message_id ?? null;
    if (channelMsgId == null) {
        return;
    }
    (0, postCommentMappingStore_1.linkThreadMessageToChannelPost)(chainId, channelMsgId, message.chat.id, message.message_id);
    logger_1.logger.info('[tgCommentSync] linked discussion post', {
        chainId,
        channelMsgId,
        threadMsgId: message.message_id,
        threadChatId: message.chat.id,
    });
}
function listExistingReplyTexts(comment) {
    const thread = Array.isArray(comment.replies) && comment.replies.length > 0
        ? comment.replies
        : comment.reply?.text?.trim()
            ? [comment.reply]
            : [];
    return thread.map((r) => r.text.trim()).filter(Boolean);
}
/**
 * Реплай в TG на комментарий, перенесённый из TG в MAX: пометка «отвечено в Telegram»,
 * без исходящего сообщения в TG. Текст ответа админа сохраняется в MAX.
 */
async function handleTgReplyToSyncedTelegramComment(message, parentComment, chain, bot, maxChatId, post, tgCommentId, isAdmin) {
    const text = (message.text || message.caption || '').trim();
    commentStore_1.commentStore.markAnsweredInTelegram(parentComment.comment_id);
    if (!isAdmin || !text || (0, commentSyncFilter_1.isMaxAdminReplyInTelegram)(text)) {
        (0, commentSyncGuard_1.markCommentSynced)(`tg:${tgCommentId}`);
        logger_1.logger.info('[tgCommentSync] marked TG-origin comment as answered in Telegram', {
            chainId: chain.id,
            tgCommentId,
            parentCommentId: parentComment.comment_id,
            isAdmin,
        });
        return;
    }
    if (listExistingReplyTexts(parentComment).includes(text)) {
        (0, commentSyncGuard_1.markCommentSynced)(`tg:${tgCommentId}`);
        return;
    }
    const channelTitle = channelRegistry_1.channelRegistry.getChannel(maxChatId)?.title?.trim() || chain.max_title?.trim() || 'Канал';
    const updated = commentStore_1.commentStore.addReply(parentComment.comment_id, text, channelTitle, [], 'Telegram', true);
    if (!updated) {
        (0, commentSyncGuard_1.markCommentSynced)(`tg:${tgCommentId}`);
        return;
    }
    (0, commentSyncGuard_1.markCommentSynced)(`tg:${tgCommentId}`);
    (0, commentSyncGuard_1.markCommentSynced)(`max-reply:${updated.comment_id}:${text}`);
    try {
        await (0, notificationService_1.syncAdminCommentNotification)(bot, updated, post.post_id, maxChatId);
    }
    catch (err) {
        logger_1.logger.warn('[tgCommentSync] sync MAX admin notification failed', {
            commentId: updated.comment_id,
            err,
        });
    }
    try {
        await (0, telegramAdminNotificationService_1.syncTelegramAdminCommentNotification)({
            comment: updated,
            postId: post.post_id,
            channelChatId: maxChatId,
            messageMid: post.message_mid,
        });
    }
    catch (err) {
        logger_1.logger.warn('[tgCommentSync] sync TG admin notification failed', {
            commentId: updated.comment_id,
            err,
        });
    }
    try {
        await (0, notificationService_1.notifyUserAboutMiniappReply)(bot, {
            userId: Number(updated.user_id),
            commentId: updated.comment_id,
            postText: post.text,
            userCommentText: updated.text,
            adminReplyText: text,
            postId: post.post_id,
            channelChatId: maxChatId,
        });
    }
    catch (err) {
        logger_1.logger.warn('[tgCommentSync] notify user about TG admin reply failed', {
            commentId: updated.comment_id,
            err,
        });
    }
    logger_1.logger.info('[tgCommentSync] synced TG admin reply to MAX comment', {
        chainId: chain.id,
        tgCommentId,
        parentCommentId: parentComment.comment_id,
        postId: post.post_id,
    });
}
/**
 * Комментарий в TG discussion group → комментарий в miniapp.
 */
async function handleTgComment(message, chain, bot, discussionChatId) {
    if (!chain.forward_comments) {
        return;
    }
    try {
        if (!message.reply_to_message) {
            return;
        }
        const tgCommentId = message.message_id;
        const threadRootMsgId = (0, commentSyncFilter_1.resolveDiscussionThreadRootMsgId)(message);
        if (threadRootMsgId == null) {
            return;
        }
        if ((0, commentSyncGuard_1.isCommentSynced)(`tg:${tgCommentId}`)) {
            return;
        }
        if (commentStore_1.commentStore.findCommentByTgMessageId(tgCommentId)) {
            return;
        }
        let mapping = (0, postCommentMappingStore_1.findMappingByThreadMsgId)(chain.id, threadRootMsgId);
        if (!mapping?.max_mid) {
            const threadRoot = (0, commentSyncFilter_1.resolveThreadRootMessage)(message);
            const channelMsgId = threadRoot != null ? (0, commentSyncFilter_1.resolveChannelMsgIdFromThreadRoot)(threadRoot) : null;
            if (channelMsgId != null) {
                mapping = (0, postCommentMappingStore_1.findMappingByTgMsgId)(chain.id, channelMsgId);
                if (mapping?.max_mid) {
                    (0, postCommentMappingStore_1.linkThreadMessageToChannelPost)(chain.id, channelMsgId, message.chat.id, threadRootMsgId);
                    logger_1.logger.info('[tgCommentSync] linked thread via channel msg fallback', {
                        chainId: chain.id,
                        channelMsgId,
                        threadMsgId: threadRootMsgId,
                    });
                }
            }
        }
        if (!mapping?.max_mid) {
            logger_1.logger.debug('[tgCommentSync] no post mapping for thread', {
                chainId: chain.id,
                threadRootMsgId,
                tgCommentId,
            });
            return;
        }
        const maxChatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(chain.max_chat_id) ?? chain.max_chat_id;
        const post = postStore_1.postStore.findPostByChannelMessage(maxChatId, mapping.max_mid);
        if (!post) {
            logger_1.logger.warn('[tgCommentSync] post not found for mapping', {
                chainId: chain.id,
                maxMid: mapping.max_mid,
                maxChatId,
            });
            return;
        }
        const tgToken = chain.bot_token?.trim();
        if (!tgToken) {
            return;
        }
        const isAdmin = await (0, commentSyncFilter_1.isTgCommentFromAdmin)(message, tgToken, chain, discussionChatId);
        const directReplyId = message.reply_to_message.message_id;
        if (directReplyId !== threadRootMsgId) {
            const parentComment = commentStore_1.commentStore.findCommentByTgMessageId(directReplyId);
            if (parentComment && (0, commentSyncFilter_1.isTelegramOriginComment)(parentComment)) {
                await handleTgReplyToSyncedTelegramComment(message, parentComment, chain, bot, maxChatId, post, tgCommentId, isAdmin);
                return;
            }
            if (isAdmin && parentComment) {
                (0, commentSyncGuard_1.markCommentSynced)(`tg:${tgCommentId}`);
                logger_1.logger.debug('[tgCommentSync] admin reply to non-TG-origin comment skipped', {
                    chainId: chain.id,
                    tgCommentId,
                    parentCommentId: parentComment.comment_id,
                    parentSource: parentComment.source ?? null,
                });
                return;
            }
        }
        const text = (message.text || message.caption || '').trim();
        if (!text) {
            return;
        }
        const shouldSync = await (0, commentSyncFilter_1.shouldSyncTgCommentToMax)({
            message,
            chain,
            token: tgToken,
            discussionChatId,
            postCommentCount: post.comment_count,
            threadRootMsgId,
        });
        if (!shouldSync) {
            logger_1.logger.debug('[tgCommentSync] skipped by filter', {
                chainId: chain.id,
                tgCommentId,
                postId: post.post_id,
            });
            return;
        }
        const { userId, username: authorName } = (0, commentSyncFilter_1.resolveTgCommentAuthor)(message, chain, discussionChatId);
        const saved = commentStore_1.commentStore.saveTelegramThreadComment({
            post_id: post.post_id,
            user_id: userId,
            username: authorName,
            text,
        }, tgCommentId);
        (0, commentSyncGuard_1.markCommentSynced)(`max:${saved.comment_id}`);
        const newCount = postStore_1.postStore.incrementCommentCount(post.post_id);
        if (newCount !== null) {
            const updatedPost = postStore_1.postStore.getPost(post.post_id);
            if (updatedPost) {
                await postStore_1.postStore.updateButtonCaption(bot, updatedPost);
            }
        }
        const channelTitle = channelRegistry_1.channelRegistry.getChannel(maxChatId)?.title ?? chain.max_title ?? '—';
        try {
            await (0, notificationService_1.notifyAdminsNewMiniappComment)(bot, {
                commentId: saved.comment_id,
                channelChatId: maxChatId,
                postText: post.text,
                channelTitle,
                username: authorName,
                commentText: text,
                postId: post.post_id,
            });
        }
        catch (err) {
            logger_1.logger.warn('[tgCommentSync] notify MAX admins failed', { err });
        }
        logger_1.logger.info('[tgCommentSync] synced TG comment to miniapp', {
            chainId: chain.id,
            tgCommentId,
            commentId: saved.comment_id,
            postId: post.post_id,
        });
    }
    catch (err) {
        logger_1.logger.error('[tgCommentSync] unhandled error', err);
    }
}
//# sourceMappingURL=tgCommentSyncService.js.map