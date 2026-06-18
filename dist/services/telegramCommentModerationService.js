"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.canManageMaxCommentViaTelegram = canManageMaxCommentViaTelegram;
exports.handleTelegramCommentModerationCallback = handleTelegramCommentModerationCallback;
exports.tryHandleTelegramCommentModerationReply = tryHandleTelegramCommentModerationReply;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const channelCommentsButtonPolicy_1 = require("./channelCommentsButtonPolicy");
const channelLinkAdminTeamSync_1 = require("./channelLinkAdminTeamSync");
const channelPostActions_1 = require("./channelPostActions");
const resolveChannelChatId_1 = require("./resolveChannelChatId");
const channelRegistry_1 = require("./channelRegistry");
const commentStore_1 = require("./commentStore");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const notificationService_1 = require("./notificationService");
const postStore_1 = require("./postStore");
const telegramAdminNotificationService_1 = require("./telegramAdminNotificationService");
const telegramChannelNotifyLinkStore_1 = require("./telegramChannelNotifyLinkStore");
const TG_API = 'https://api.telegram.org';
const pendingRepliesByUser = new Map();
const PENDING_REPLY_TTL_MS = 15 * 60 * 1000;
function parseCommentCallbackData(data) {
    const trimmed = data.trim();
    if (!trimmed.startsWith(telegramAdminNotificationService_1.TG_COMMENT_CALLBACK_PREFIX)) {
        return null;
    }
    const rest = trimmed.slice(telegramAdminNotificationService_1.TG_COMMENT_CALLBACK_PREFIX.length);
    const m = /^(r|d|dy|cn):([0-9a-f-]{36})$/i.exec(rest);
    if (!m) {
        return null;
    }
    const actionMap = { r: 'reply', d: 'delete', dy: 'delete_yes', cn: 'cancel' };
    const action = actionMap[m[1]];
    if (!action) {
        return null;
    }
    return { action, commentId: m[2] };
}
async function answerCallbackQuery(token, callbackId, text) {
    await axios_1.default.post(`${TG_API}/bot${token}/answerCallbackQuery`, {
        callback_query_id: callbackId,
        ...(text ? { text, show_alert: text.length > 60 } : {}),
    }, { timeout: 10_000 });
}
async function sendBotMessage(token, chatId, text, replyMarkup) {
    await axios_1.default.post(`${TG_API}/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }, { timeout: 20_000 });
}
async function isTelegramAdminOfLinkedChannel(token, telegramUserId, maxChatId) {
    for (const tgChannelId of (0, telegramAdminNotificationService_1.resolveTelegramSourceChannelsForMaxChat)(maxChatId)) {
        const admins = await (0, integrationPlatformClient_1.listTelegramChatAdministrators)(token, tgChannelId);
        if (admins.some((a) => a.userId === telegramUserId)) {
            return true;
        }
    }
    return false;
}
async function canManageMaxCommentViaTelegram(bot, telegramUserId, maxChatId) {
    const channelChatId = (0, resolveChannelChatId_1.resolveCanonicalChannelChatId)(maxChatId) ?? maxChatId;
    // Check 1: paired MAX account is a channel admin
    const pairing = (0, channelLinkAdminTeamSync_1.profilePairingForPlatformUser)('telegram', telegramUserId);
    if (pairing.max_user_id != null) {
        const isMaxAdmin = await (0, channelPostActions_1.isUserChannelAdmin)(bot, channelChatId, pairing.max_user_id);
        if (isMaxAdmin) {
            return true;
        }
    }
    const token = (0, config_1.getTelegramToken)();
    if (!token) {
        return false;
    }
    // Check 2: verified TG channel admin via API (requires bot to be admin/member of TG channel)
    if (await isTelegramAdminOfLinkedChannel(token, telegramUserId, channelChatId)) {
        return true;
    }
    // Check 3: user is the tg_user_id of a TG chain for this MAX channel (chain owner receives
    // notifications via collectTelegramAdminNotifyRecipientIds, so must be allowed to reply)
    for (const chain of (0, channelCommentsButtonPolicy_1.listTgChainsForMaxChannel)(channelChatId)) {
        if (chain.tg_user_id === telegramUserId) {
            return true;
        }
    }
    // Check 4: user is registered in the notify link store for a linked TG channel — covers admins
    // who enrolled via invite link or syncChannelLinkAdminTeam when the bot's API check may fail
    for (const tgChannelId of (0, telegramAdminNotificationService_1.resolveTelegramSourceChannelsForMaxChat)(channelChatId)) {
        if (telegramChannelNotifyLinkStore_1.telegramChannelNotifyLinkStore.isLinked(telegramUserId, tgChannelId)) {
            return true;
        }
    }
    return false;
}
function resolveCommentContext(commentId) {
    const comment = commentStore_1.commentStore.getComment(commentId);
    if (!comment) {
        return null;
    }
    const post = postStore_1.postStore.getPost(comment.post_id);
    if (!post) {
        return null;
    }
    return { comment, post, maxChatId: post.chat_id };
}
function setPendingReply(telegramUserId, pending) {
    pendingRepliesByUser.set(telegramUserId, {
        ...pending,
        expiresAt: Date.now() + PENDING_REPLY_TTL_MS,
    });
}
function takePendingReply(telegramUserId) {
    const pending = pendingRepliesByUser.get(telegramUserId);
    if (!pending) {
        return null;
    }
    if (Date.now() > pending.expiresAt) {
        pendingRepliesByUser.delete(telegramUserId);
        return null;
    }
    pendingRepliesByUser.delete(telegramUserId);
    return pending;
}
function clearPendingReply(telegramUserId) {
    pendingRepliesByUser.delete(telegramUserId);
}
async function performCommentDelete(bot, telegramUserId, commentId) {
    const ctx = resolveCommentContext(commentId);
    if (!ctx) {
        return { ok: false, error: 'Комментарий не найден' };
    }
    const allowed = await canManageMaxCommentViaTelegram(bot, telegramUserId, ctx.maxChatId);
    if (!allowed) {
        return { ok: false, error: 'Нет прав на удаление' };
    }
    const removed = commentStore_1.commentStore.getComment(commentId);
    if (!removed) {
        return { ok: false, error: 'Комментарий не найден' };
    }
    commentStore_1.commentStore.deleteComment(commentId);
    const newCount = postStore_1.postStore.decrementCommentCount(ctx.post.post_id);
    if (newCount !== null) {
        const updatedPost = postStore_1.postStore.getPost(ctx.post.post_id);
        if (updatedPost) {
            await postStore_1.postStore.updateButtonCaption(bot, updatedPost);
        }
    }
    await (0, telegramAdminNotificationService_1.syncTelegramAdminCommentNotification)({
        comment: removed,
        postId: ctx.post.post_id,
        channelChatId: ctx.maxChatId,
        messageMid: ctx.post.message_mid,
        deleted: true,
    });
    return { ok: true };
}
async function performCommentReply(bot, telegramUserId, commentId, replyText) {
    const trimmed = replyText.trim();
    if (trimmed === '') {
        return { ok: false, error: 'Текст ответа пустой' };
    }
    const ctx = resolveCommentContext(commentId);
    if (!ctx) {
        return { ok: false, error: 'Комментарий не найден' };
    }
    const allowed = await canManageMaxCommentViaTelegram(bot, telegramUserId, ctx.maxChatId);
    if (!allowed) {
        return { ok: false, error: 'Нет прав на ответ' };
    }
    const channelReplyName = channelRegistry_1.channelRegistry.getChannel(ctx.maxChatId)?.title?.trim() || 'Канал';
    const pairing = (0, channelLinkAdminTeamSync_1.profilePairingForPlatformUser)('telegram', telegramUserId);
    const replierName = pairing.max_user_id != null
        ? `администратор`
        : 'администратор Telegram';
    const updated = commentStore_1.commentStore.addReply(commentId, trimmed, channelReplyName, [], replierName);
    if (!updated) {
        return { ok: false, error: 'Не удалось сохранить ответ' };
    }
    try {
        await (0, notificationService_1.syncAdminCommentNotification)(bot, updated, ctx.post.post_id, ctx.maxChatId);
    }
    catch (err) {
        logger_1.logger.warn('performCommentReply: sync MAX admin notification failed', { commentId, err });
    }
    try {
        await (0, telegramAdminNotificationService_1.syncTelegramAdminCommentNotification)({
            comment: updated,
            postId: ctx.post.post_id,
            channelChatId: ctx.maxChatId,
            messageMid: ctx.post.message_mid,
        });
    }
    catch (err) {
        logger_1.logger.warn('performCommentReply: sync TG admin notification failed', { commentId, err });
    }
    await (0, notificationService_1.notifyUserAboutMiniappReply)(bot, {
        userId: Number(updated.user_id),
        commentId: updated.comment_id,
        postText: ctx.post.text,
        userCommentText: updated.text,
        adminReplyText: trimmed,
        postId: ctx.post.post_id,
        channelChatId: ctx.maxChatId,
    });
    return { ok: true };
}
async function handleTelegramCommentModerationCallback(update, bot) {
    const cq = update.callback_query;
    if (!cq) {
        return false;
    }
    const data = typeof cq.data === 'string' ? cq.data.trim() : '';
    const parsed = parseCommentCallbackData(data);
    if (!parsed) {
        return false;
    }
    const from = cq.from;
    const telegramUserId = typeof from?.id === 'number' ? from.id : null;
    const callbackId = typeof cq.id === 'string' ? cq.id : null;
    if (telegramUserId == null || !callbackId) {
        return true;
    }
    const token = (0, config_1.getTelegramToken)();
    if (!token) {
        return true;
    }
    const ctx = resolveCommentContext(parsed.commentId);
    if (!ctx && parsed.action !== 'cancel') {
        try {
            await answerCallbackQuery(token, callbackId, 'Комментарий не найден');
        }
        catch {
            /* ignore */
        }
        return true;
    }
    if (parsed.action === 'cancel') {
        clearPendingReply(telegramUserId);
        try {
            await answerCallbackQuery(token, callbackId);
        }
        catch {
            /* ignore */
        }
        return true;
    }
    const allowed = ctx != null ? await canManageMaxCommentViaTelegram(bot, telegramUserId, ctx.maxChatId) : false;
    if (!allowed) {
        try {
            await answerCallbackQuery(token, callbackId, 'Нет прав');
        }
        catch {
            /* ignore */
        }
        return true;
    }
    if (parsed.action === 'reply') {
        setPendingReply(telegramUserId, {
            commentId: parsed.commentId,
            postId: ctx.post.post_id,
            maxChatId: ctx.maxChatId,
        });
        try {
            await answerCallbackQuery(token, callbackId);
        }
        catch {
            /* ignore */
        }
        await sendBotMessage(token, telegramUserId, '✍️ Напишите ответ на комментарий одним сообщением.\n\nОтмена: /cancel');
        return true;
    }
    if (parsed.action === 'delete') {
        try {
            await answerCallbackQuery(token, callbackId);
        }
        catch {
            /* ignore */
        }
        await sendBotMessage(token, telegramUserId, 'Удалить этот комментарий в MAX?', {
            inline_keyboard: [
                [
                    { text: '✅ Да, удалить', callback_data: `${telegramAdminNotificationService_1.TG_COMMENT_CALLBACK_PREFIX}dy:${parsed.commentId}` },
                    { text: 'Отмена', callback_data: `${telegramAdminNotificationService_1.TG_COMMENT_CALLBACK_PREFIX}cn:${parsed.commentId}` },
                ],
            ],
        });
        return true;
    }
    if (parsed.action === 'delete_yes') {
        const result = await performCommentDelete(bot, telegramUserId, parsed.commentId);
        try {
            await answerCallbackQuery(token, callbackId, result.ok ? 'Комментарий удалён' : result.error);
        }
        catch {
            /* ignore */
        }
        if (result.ok) {
            await sendBotMessage(token, telegramUserId, '✅ Комментарий удалён в MAX.');
        }
        return true;
    }
    return true;
}
async function tryHandleTelegramCommentModerationReply(bot, telegramUserId, text) {
    const trimmed = text.trim();
    if (trimmed === '/cancel' || trimmed === '/cancel@commentvmax_bot') {
        if (pendingRepliesByUser.has(telegramUserId)) {
            clearPendingReply(telegramUserId);
            const token = (0, config_1.getTelegramToken)();
            if (token) {
                await sendBotMessage(token, telegramUserId, 'Ответ отменён.');
            }
            return true;
        }
        return false;
    }
    const pending = takePendingReply(telegramUserId);
    if (!pending) {
        return false;
    }
    const token = (0, config_1.getTelegramToken)();
    if (!token) {
        return true;
    }
    const result = await performCommentReply(bot, telegramUserId, pending.commentId, trimmed);
    if (result.ok) {
        await sendBotMessage(token, telegramUserId, '✅ Ответ опубликован в MAX.');
    }
    else {
        await sendBotMessage(token, telegramUserId, `❌ ${result.error}`);
    }
    return true;
}
//# sourceMappingURL=telegramCommentModerationService.js.map