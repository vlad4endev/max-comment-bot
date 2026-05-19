"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getChannelAdmins = getChannelAdmins;
exports.deliverAdminNotifications = deliverAdminNotifications;
exports.collectAdminNotifyRecipientIds = collectAdminNotifyRecipientIds;
exports.notifyAllAdmins = notifyAllAdmins;
exports.notifyAdminsNewMiniappComment = notifyAdminsNewMiniappComment;
exports.buildAdminCommentNotificationBody = buildAdminCommentNotificationBody;
exports.syncAdminCommentNotification = syncAdminCommentNotification;
exports.notifyUserAboutMiniappReply = notifyUserAboutMiniappReply;
const max_bot_api_1 = require("@maxhub/max-bot-api");
const config_1 = require("../config");
const channelNotifyLinkStore_1 = require("./channelNotifyLinkStore");
const commentStore_1 = require("./commentStore");
const subscriberStore_1 = require("./subscriberStore");
const postStore_1 = require("./postStore");
const stateManager_1 = require("./stateManager");
const logger_1 = require("../utils/logger");
function preview80(text) {
    const t = text.trim().replace(/\s+/g, ' ');
    if (t.length <= 80) {
        return t;
    }
    return `${t.slice(0, 80)}…`;
}
function parseNotifyUserId(value) {
    const userId = Number(value);
    if (!Number.isInteger(userId) || userId <= 0) {
        return null;
    }
    return userId;
}
/** Extract MAX API error fields for logs (status / response body when present). */
function loggableApiError(err) {
    if (err instanceof Error) {
        const extra = err;
        return {
            error: err.message,
            errorCode: typeof extra.status === 'number' ? extra.status : undefined,
            errorResponse: extra.response,
        };
    }
    if (typeof err === 'object' && err !== null) {
        const o = err;
        const msg = typeof o.message === 'string'
            ? o.message
            : typeof o.error === 'string'
                ? o.error
                : String(err);
        return {
            error: msg,
            errorCode: typeof o.status === 'number' ? o.status : undefined,
            errorResponse: o.response,
        };
    }
    return { error: String(err) };
}
function isChannelAdminOrOwner(member) {
    return !member.is_bot && (member.is_admin || member.is_owner);
}
/**
 * Возвращает user_id админов и владельцев чата (роли в API: {@link ChatMember.is_admin} / {@link ChatMember.is_owner}).
 * Вызывает {@link Bot.api.getChatAdmins} → `GET chats/{chat_id}/members/admins`.
 */
async function getChannelAdmins(bot, chatId) {
    try {
        const { members } = await bot.api.getChatAdmins(chatId);
        const ids = members.filter(isChannelAdminOrOwner).map((m) => m.user_id);
        const unique = [...new Set(ids)];
        if (unique.length === 0) {
            logger_1.logger.warn('getChannelAdmins: список админов пуст, используем ADMIN_CHAT_ID', {
                chatId,
            });
            return [config_1.config.ADMIN_CHAT_ID];
        }
        return unique;
    }
    catch (err) {
        logger_1.logger.warn('getChannelAdmins: не удалось получить админов, fallback на ADMIN_CHAT_ID', {
            chatId,
            err,
        });
        return [config_1.config.ADMIN_CHAT_ID];
    }
}
function isFallbackAdminChatRecipient(recipientId) {
    return recipientId === config_1.config.ADMIN_CHAT_ID;
}
/** MAX: нет личного диалога с пользователем (часто не нажали /start боту). */
function isDialogNotFoundError(err) {
    if (typeof err !== 'object' || err === null) {
        return false;
    }
    const o = err;
    if (o.status !== 404) {
        return false;
    }
    const code = o.response && typeof o.response === 'object' ? o.response.code : undefined;
    return code === 'dialog.not.found';
}
/**
 * Личка админу: сначала {@link Bot.api.sendMessageToUser}; при `dialog.not.found` — повтор в сохранённый
 * приватный чат (`stateManager`), если пользователь уже открывал бота.
 */
async function sendAdminDirectMessage(bot, recipientId, message, extra) {
    if (isFallbackAdminChatRecipient(recipientId)) {
        return bot.api.sendMessageToChat(config_1.config.ADMIN_CHAT_ID, message, extra);
    }
    try {
        return await bot.api.sendMessageToUser(recipientId, message, extra);
    }
    catch (firstErr) {
        if (!isDialogNotFoundError(firstErr)) {
            throw firstErr;
        }
        const privateChatId = stateManager_1.stateManager.getUserPrivateChatId(recipientId);
        if (privateChatId === undefined) {
            throw firstErr;
        }
        try {
            const sent = await bot.api.sendMessageToChat(privateChatId, message, extra);
            return sent;
        }
        catch {
            throw firstErr;
        }
    }
}
async function deliverAdminNotifications(bot, sourceChatId, recipientIds, message, extra) {
    const unique = [...new Set(recipientIds)];
    const out = [];
    for (const recipientId of unique) {
        try {
            const sent = await sendAdminDirectMessage(bot, recipientId, message, extra);
            out.push({ admin_id: recipientId, message_mid: sent.body.mid });
            logger_1.logger.info('Уведомление админу доставлено', { recipientId, sourceChat: sourceChatId });
        }
        catch (err) {
            if (isDialogNotFoundError(err)) {
                logger_1.logger.debug('Не удалось отправить уведомление админу: нет диалога с ботом (нужен /start в личке с ботом)', {
                    recipientId,
                    sourceChat: sourceChatId,
                    ...loggableApiError(err),
                });
            }
            else {
                logger_1.logger.warn('Не удалось отправить уведомление админу (пропускаем и идём дальше)', {
                    recipientId,
                    sourceChat: sourceChatId,
                    err,
                });
            }
        }
    }
    return out;
}
/**
 * Кто получает DM: сначала явно подключившиеся через invite, плюс админы/владельцы из API.
 */
async function collectAdminNotifyRecipientIds(bot, channelChatId) {
    const recipients = new Set();
    const linked = channelNotifyLinkStore_1.channelNotifyLinkStore.getUserIdsForChannel(channelChatId);
    for (const userId of linked) {
        recipients.add(userId);
    }
    const admins = await getChannelAdmins(bot, channelChatId);
    for (const userId of admins) {
        recipients.add(userId);
    }
    logger_1.logger.info('notifyAllAdmins: recipients', {
        chatId: channelChatId,
        linked,
        total: recipients.size,
    });
    return [...recipients];
}
/**
 * Уведомляет всех админов канала личными сообщениями; для `ADMIN_CHAT_ID` используется `sendMessageToChat` (супер-админ / группа).
 * Возвращает пары `admin_id` / `message_mid` только для успешно отправленных сообщений.
 */
async function notifyAllAdmins(bot, chatId, message, extra) {
    const recipients = await collectAdminNotifyRecipientIds(bot, chatId);
    return deliverAdminNotifications(bot, chatId, recipients, message, extra);
}
/**
 * Уведомляет админов канала о новом комментарии из Mini App (текст + ссылка на приложение с admin=1).
 */
async function notifyAdminsNewMiniappComment(bot, input) {
    if (!(0, postStore_1.isMiniAppOpenUrlConfigured)()) {
        logger_1.logger.warn('notifyAdminsNewMiniappComment: BOT_NICKNAME / MINI_APP_URL not set for Mini App links');
        return;
    }
    const openUrl = (0, postStore_1.buildMiniAppUrl)(input.postId, input.channelChatId, { admin: '1' });
    const keyboard = max_bot_api_1.Keyboard.inlineKeyboard([
        [max_bot_api_1.Keyboard.button.link('💬 Открыть комментарии', openUrl)],
    ]);
    const postExcerpt = preview80(input.postText);
    const textPart = input.commentText.trim();
    const photoCount = Array.isArray(input.commentPhotoUrls) ? input.commentPhotoUrls.length : 0;
    const commentPreview = textPart !== ''
        ? textPart
        : photoCount > 0
            ? `📷 Фото: ${photoCount}`
            : 'без текста';
    const photoSuffix = photoCount > 0 ? `\n📷 Фото: ${photoCount}` : '';
    const message = `📌 Новый комментарий
Пост: «${postExcerpt}»
Канал: ${input.channelTitle}
👤 ${input.username}: ${commentPreview}${photoSuffix}`;
    commentStore_1.commentStore.saveNotificationText(input.commentId, message);
    const recipientIds = await collectAdminNotifyRecipientIds(bot, input.channelChatId);
    const sent = await deliverAdminNotifications(bot, input.channelChatId, recipientIds, message, {
        attachments: [keyboard],
    });
    for (const { admin_id, message_mid } of sent) {
        commentStore_1.commentStore.saveNotificationMid(input.commentId, admin_id, message_mid);
    }
}
function countChannelReplies(comment) {
    if (Array.isArray(comment.replies) && comment.replies.length > 0) {
        return comment.replies.length;
    }
    return comment.reply ? 1 : 0;
}
function isCommentAnsweredByChannel(comment) {
    return countChannelReplies(comment) > 0;
}
function buildAdminCommentNotificationKeyboard(postId, channelChatId, answered) {
    const openUrl = (0, postStore_1.buildMiniAppUrl)(postId, channelChatId, { admin: '1' });
    const label = answered ? '✅ Отвечено' : '💬 Открыть комментарии';
    return max_bot_api_1.Keyboard.inlineKeyboard([[max_bot_api_1.Keyboard.button.link(label, openUrl)]]);
}
/**
 * Текст одного DM админу: исходное «новый комментарий» без изменений.
 * Статус «отвечено» — на инлайн-кнопке после ответа канала.
 */
function buildAdminCommentNotificationBody(comment) {
    const base = comment.notification_text?.trim();
    if (!base) {
        return null;
    }
    return base;
}
/**
 * Обновляет одно и то же уведомление админам о комментарии (дописывает хронологию ответов).
 */
async function syncAdminCommentNotification(bot, comment, postId, channelChatId) {
    const body = buildAdminCommentNotificationBody(comment);
    if (!body) {
        logger_1.logger.warn('syncAdminCommentNotification: missing notification_text', {
            commentId: comment.comment_id,
        });
        return;
    }
    const mids = commentStore_1.commentStore.getNotificationMids(comment.comment_id);
    if (mids.length === 0) {
        return;
    }
    if (!(0, postStore_1.isMiniAppOpenUrlConfigured)()) {
        logger_1.logger.warn('syncAdminCommentNotification: BOT_NICKNAME / MINI_APP_URL not set for Mini App links');
        return;
    }
    const answered = isCommentAnsweredByChannel(comment);
    const keyboard = buildAdminCommentNotificationKeyboard(postId, channelChatId, answered);
    for (const { admin_id, message_mid } of mids) {
        try {
            await bot.api.editMessage(message_mid, {
                text: body,
                attachments: [keyboard],
            });
        }
        catch (e) {
            logger_1.logger.warn('syncAdminCommentNotification: editMessage failed', {
                admin_id,
                message_mid,
                commentId: comment.comment_id,
                e,
            });
        }
    }
}
/**
 * Шлёт пользователю DM об ответе канала на комментарий (кнопка «Открыть»). Ошибки доставки логируются.
 */
async function notifyUserAboutMiniappReply(bot, input) {
    const userId = parseNotifyUserId(input.userId);
    if (userId === null) {
        logger_1.logger.warn('notifyUserAboutMiniappReply: invalid userId', {
            userId: input.userId,
            commentId: input.commentId,
        });
        return;
    }
    logger_1.logger.info('notifyUserAboutMiniappReply: attempting', {
        userId,
        commentId: input.commentId,
        isSubscriber: subscriberStore_1.subscriberStore.hasSubscriber(userId),
        commentText: input.userCommentText.slice(0, 50),
    });
    if (!subscriberStore_1.subscriberStore.hasSubscriber(userId)) {
        return;
    }
    if (!(0, postStore_1.isMiniAppOpenUrlConfigured)()) {
        logger_1.logger.warn('notifyUserAboutMiniappReply: BOT_NICKNAME / MINI_APP_URL not set for Mini App links');
        return;
    }
    const openUrl = (0, postStore_1.buildMiniAppUrl)(input.postId, input.channelChatId);
    const keyboard = max_bot_api_1.Keyboard.inlineKeyboard([[max_bot_api_1.Keyboard.button.link('Открыть', openUrl)]]);
    const postPreview = input.postText.slice(0, 60);
    const commentPreview = input.userCommentText.slice(0, 60);
    const replyPreview = input.adminReplyText.slice(0, 80);
    const replyPhotoCount = Array.isArray(input.adminReplyPhotoUrls)
        ? input.adminReplyPhotoUrls.length
        : 0;
    const replyBody = replyPreview.trim() !== ''
        ? `Ответ канала: ${replyPreview}`
        : replyPhotoCount > 0
            ? `Ответ канала: 📷 Фото (${replyPhotoCount})`
            : 'Ответ канала';
    const photoSuffix = replyPhotoCount > 0 ? `\nФото в ответе: ${replyPhotoCount}` : '';
    const message = `💬 Вам ответили на комментарий\n\n` +
        `Пост: «${postPreview}»\n` +
        `Ваш комментарий: «${commentPreview}»\n\n` +
        `${replyBody}${photoSuffix}`;
    try {
        await bot.api.sendMessageToUser(userId, message, { attachments: [keyboard] });
        logger_1.logger.info('notifyUserAboutMiniappReply: delivered', { userId, commentId: input.commentId });
    }
    catch (err) {
        const apiErr = loggableApiError(err);
        logger_1.logger.warn('notifyUserAboutMiniappReply: could not deliver', {
            userId,
            commentId: input.commentId,
            ...apiErr,
        });
    }
}
//# sourceMappingURL=notificationService.js.map