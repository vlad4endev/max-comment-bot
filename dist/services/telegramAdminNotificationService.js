"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TG_COMMENT_CALLBACK_PREFIX = void 0;
exports.resolveTelegramSourceChannelsForMaxChat = resolveTelegramSourceChannelsForMaxChat;
exports.collectTelegramAdminNotifyRecipientIds = collectTelegramAdminNotifyRecipientIds;
exports.buildNewCommentNotificationMessage = buildNewCommentNotificationMessage;
exports.buildTelegramCommentNotificationKeyboard = buildTelegramCommentNotificationKeyboard;
exports.notifyTelegramAdminsNewMiniappComment = notifyTelegramAdminsNewMiniappComment;
exports.syncTelegramAdminCommentNotification = syncTelegramAdminCommentNotification;
const axios_1 = __importDefault(require("axios"));
const config_1 = require("../config");
const logger_1 = require("../utils/logger");
const telegramMiniAppUrl_1 = require("../utils/telegramMiniAppUrl");
const channelNotifyLinkStore_1 = require("./channelNotifyLinkStore");
const channelLinkAdminTeamSync_1 = require("./channelLinkAdminTeamSync");
const commentStore_1 = require("./commentStore");
const notificationService_1 = require("./notificationService");
const integrationsStore_1 = require("./integrationsStore");
const integrationPlatformClient_1 = require("./integrationPlatformClient");
const telegramMiniappAuth_1 = require("./telegramMiniappAuth");
const telegramBotUserStore_1 = require("./telegramBotUserStore");
const telegramChannelNotifyLinkStore_1 = require("./telegramChannelNotifyLinkStore");
const TG_API = 'https://api.telegram.org';
exports.TG_COMMENT_CALLBACK_PREFIX = 'tgc:';
function preview80(text) {
    const t = text.trim().replace(/\s+/g, ' ');
    if (t.length <= 80) {
        return t;
    }
    return `${t.slice(0, 80)}…`;
}
function resolveTelegramSourceChannelsForMaxChat(maxChatId) {
    const targetAbs = Math.abs(maxChatId);
    const out = new Set();
    for (const flow of integrationsStore_1.integrationsStore.getFlows()) {
        if (!flow.enabled) {
            continue;
        }
        if (flow.source.platform !== 'telegram' || flow.destination.platform !== 'max') {
            continue;
        }
        const dest = Number.parseInt(flow.destination.channelId, 10);
        if (!Number.isFinite(dest) || Math.abs(dest) !== targetAbs) {
            continue;
        }
        const sourceChannel = flow.source.channelId?.trim() || flow.source.channelUsername?.trim() || '';
        if (sourceChannel !== '') {
            out.add(sourceChannel);
        }
    }
    return [...out];
}
function hasTelegramIntegrationForMaxChat(maxChatId) {
    return resolveTelegramSourceChannelsForMaxChat(maxChatId).length > 0;
}
function mapMaxUserToTelegramRecipient(maxUserId, recipients) {
    const pairing = (0, channelLinkAdminTeamSync_1.profilePairingForPlatformUser)('max', maxUserId);
    if (pairing.tg_user_id != null && telegramBotUserStore_1.telegramBotUserStore.hasStarted(pairing.tg_user_id)) {
        recipients.add(pairing.tg_user_id);
    }
}
/**
 * Кто получает TG-DM о комментариях MAX-канала (зеркало MAX: opt-in + админы, у кого есть Telegram).
 */
async function collectTelegramAdminNotifyRecipientIds(bot, maxChannelChatId) {
    const recipients = new Set();
    for (const maxUserId of channelNotifyLinkStore_1.channelNotifyLinkStore.getUserIdsForChannel(maxChannelChatId)) {
        mapMaxUserToTelegramRecipient(maxUserId, recipients);
    }
    const maxAdmins = await (0, notificationService_1.getChannelAdmins)(bot, maxChannelChatId);
    for (const maxUserId of maxAdmins) {
        mapMaxUserToTelegramRecipient(maxUserId, recipients);
    }
    const token = (0, config_1.getTelegramToken)();
    for (const tgChannelId of resolveTelegramSourceChannelsForMaxChat(maxChannelChatId)) {
        for (const tgUserId of telegramChannelNotifyLinkStore_1.telegramChannelNotifyLinkStore.getUserIdsForChannel(tgChannelId)) {
            if (telegramBotUserStore_1.telegramBotUserStore.hasStarted(tgUserId)) {
                recipients.add(tgUserId);
            }
        }
        if (token) {
            const admins = await (0, integrationPlatformClient_1.listTelegramChatAdministrators)(token, tgChannelId);
            for (const admin of admins) {
                if (admin.startedBot) {
                    recipients.add(admin.userId);
                }
            }
        }
    }
    return [...recipients];
}
function buildNewCommentNotificationMessage(input) {
    const postExcerpt = preview80(input.postText);
    const textPart = input.commentText.trim();
    const photoCount = Array.isArray(input.commentPhotoUrls) ? input.commentPhotoUrls.length : 0;
    const commentPreview = textPart !== ''
        ? textPart
        : photoCount > 0
            ? `📷 Фото: ${photoCount}`
            : 'без текста';
    const photoSuffix = photoCount > 0 ? `\n📷 Фото: ${photoCount}` : '';
    return `📌 Новый комментарий
Пост: «${postExcerpt}»
Канал: ${input.channelTitle}
👤 ${input.username}: ${commentPreview}${photoSuffix}`;
}
function isCommentAnsweredByChannel(comment) {
    if (Array.isArray(comment.replies) && comment.replies.length > 0) {
        return true;
    }
    return !!comment.reply;
}
function buildTelegramCommentNotificationKeyboard(input) {
    const openLabel = input.answered ? '✅ Отвечено' : '💬 Открыть комментарии';
    const miniAppUrl = (0, telegramMiniappAuth_1.buildTelegramMiniappUrl)({
        postId: input.postId,
        maxChatId: input.maxChatId,
        messageMid: input.messageMid,
        telegramUserId: input.telegramUserId,
    });
    const openBtn = miniAppUrl != null
        ? { text: openLabel, web_app: { url: (0, telegramMiniAppUrl_1.withTelegramMiniappPlatform)(miniAppUrl) } }
        : { text: openLabel, url: 'https://t.me/commentvmax_bot' };
    const rows = [[openBtn]];
    if (input.includeModeration !== false && !input.answered) {
        rows.push([
            { text: '💬 Ответить', callback_data: `${exports.TG_COMMENT_CALLBACK_PREFIX}r:${input.commentId}` },
            { text: '🗑 Удалить', callback_data: `${exports.TG_COMMENT_CALLBACK_PREFIX}d:${input.commentId}` },
        ]);
    }
    return { inline_keyboard: rows };
}
async function tgSendMessage(token, chatId, text, replyMarkup) {
    const { data } = await axios_1.default.post(`${TG_API}/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        reply_markup: replyMarkup,
    }, { timeout: 20_000 });
    const messageId = data.result?.message_id;
    return typeof messageId === 'number' ? messageId : null;
}
async function tgEditMessage(token, chatId, messageId, text, replyMarkup) {
    await axios_1.default.post(`${TG_API}/bot${token}/editMessageText`, {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: replyMarkup,
    }, { timeout: 20_000 });
}
async function notifyTelegramAdminsNewMiniappComment(bot, input) {
    await integrationsStore_1.integrationsStore.load();
    const token = (0, config_1.getTelegramToken)();
    if (!token) {
        return;
    }
    if (!hasTelegramIntegrationForMaxChat(input.maxChannelChatId)) {
        return;
    }
    const message = buildNewCommentNotificationMessage(input);
    commentStore_1.commentStore.saveNotificationText(input.commentId, message);
    const recipientIds = await collectTelegramAdminNotifyRecipientIds(bot, input.maxChannelChatId);
    if (recipientIds.length === 0) {
        return;
    }
    for (const recipientId of recipientIds) {
        const url = (0, telegramMiniappAuth_1.buildTelegramMiniappUrl)({
            postId: input.postId,
            maxChatId: input.maxChannelChatId,
            messageMid: input.messageMid,
            telegramUserId: recipientId,
        });
        if (!url) {
            logger_1.logger.warn('notifyTelegramAdminsNewMiniappComment: MINI_APP_URL не задан, TG-кнопка пропущена', {
                commentId: input.commentId,
                recipientId,
            });
            continue;
        }
        const keyboard = buildTelegramCommentNotificationKeyboard({
            postId: input.postId,
            maxChatId: input.maxChannelChatId,
            messageMid: input.messageMid,
            telegramUserId: recipientId,
            commentId: input.commentId,
            answered: false,
        });
        try {
            const messageId = await tgSendMessage(token, recipientId, message, keyboard);
            if (messageId != null) {
                commentStore_1.commentStore.saveTgNotificationMid(input.commentId, recipientId, messageId);
            }
            logger_1.logger.info('notifyTelegramAdminsNewMiniappComment: delivered', {
                commentId: input.commentId,
                recipientId,
            });
        }
        catch (err) {
            logger_1.logger.warn('notifyTelegramAdminsNewMiniappComment: sendMessage failed', {
                commentId: input.commentId,
                recipientId,
                err,
            });
        }
    }
}
async function syncTelegramAdminCommentNotification(input) {
    const token = (0, config_1.getTelegramToken)();
    if (!token) {
        return;
    }
    const mids = commentStore_1.commentStore.getTgNotificationMids(input.comment.comment_id);
    if (mids.length === 0) {
        return;
    }
    const body = input.deleted
        ? '🗑 Комментарий удалён'
        : (0, notificationService_1.buildAdminCommentNotificationBody)(input.comment);
    if (!body) {
        return;
    }
    const answered = isCommentAnsweredByChannel(input.comment);
    for (const { tg_user_id, message_id } of mids) {
        const keyboard = buildTelegramCommentNotificationKeyboard({
            postId: input.postId,
            maxChatId: input.channelChatId,
            messageMid: input.messageMid,
            telegramUserId: tg_user_id,
            commentId: input.comment.comment_id,
            answered,
            includeModeration: !input.deleted && !answered,
        });
        try {
            await tgEditMessage(token, tg_user_id, message_id, body, keyboard);
        }
        catch (err) {
            logger_1.logger.warn('syncTelegramAdminCommentNotification: editMessage failed', {
                tg_user_id,
                message_id,
                commentId: input.comment.comment_id,
                err,
            });
        }
    }
}
//# sourceMappingURL=telegramAdminNotificationService.js.map