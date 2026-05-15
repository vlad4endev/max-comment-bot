"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getChannelAdmins = getChannelAdmins;
exports.notifyAllAdmins = notifyAllAdmins;
exports.notifyAdminsNewMiniappComment = notifyAdminsNewMiniappComment;
exports.notifyUserAboutMiniappReply = notifyUserAboutMiniappReply;
const max_bot_api_1 = require("@maxhub/max-bot-api");
const config_1 = require("../config");
const channelNotifyLinkStore_1 = require("./channelNotifyLinkStore");
const commentStore_1 = require("./commentStore");
const postStore_1 = require("./postStore");
const logger_1 = require("../utils/logger");
function preview80(text) {
    const t = text.trim().replace(/\s+/g, ' ');
    if (t.length <= 80) {
        return t;
    }
    return `${t.slice(0, 80)}…`;
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
async function deliverAdminNotifications(bot, sourceChatId, recipientIds, message, extra) {
    const unique = [...new Set(recipientIds)];
    const out = [];
    for (const recipientId of unique) {
        try {
            const sent = isFallbackAdminChatRecipient(recipientId)
                ? await bot.api.sendMessageToChat(config_1.config.ADMIN_CHAT_ID, message, extra)
                : await bot.api.sendMessageToUser(recipientId, message, extra);
            out.push({ admin_id: recipientId, message_mid: sent.body.mid });
            logger_1.logger.info('Уведомление админу доставлено', { recipientId, sourceChat: sourceChatId });
        }
        catch (err) {
            logger_1.logger.warn('Не удалось отправить уведомление админу (пропускаем и идём дальше)', {
                recipientId,
                sourceChat: sourceChatId,
                err,
            });
        }
    }
    return out;
}
/**
 * Кто получает DM о новом комментарии: явные подписки из мини-приложения, иначе все админы из API.
 */
async function resolveMiniappCommentNotifyRecipientIds(bot, channelChatId) {
    const linked = channelNotifyLinkStore_1.channelNotifyLinkStore.getUserIdsForChannel(channelChatId);
    if (linked.length > 0) {
        return linked;
    }
    return getChannelAdmins(bot, channelChatId);
}
/**
 * Уведомляет всех админов канала личными сообщениями; для `ADMIN_CHAT_ID` используется `sendMessageToChat` (супер-админ / группа).
 * Возвращает пары `admin_id` / `message_mid` только для успешно отправленных сообщений.
 */
async function notifyAllAdmins(bot, chatId, message, extra) {
    const recipients = await getChannelAdmins(bot, chatId);
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
    const message = `📌 Новый комментарий
Пост: «${postExcerpt}»
Канал: ${input.channelTitle}
👤 ${input.username}: ${input.commentText}`;
    commentStore_1.commentStore.saveNotificationText(input.commentId, message);
    const recipientIds = await resolveMiniappCommentNotifyRecipientIds(bot, input.channelChatId);
    const sent = await deliverAdminNotifications(bot, input.channelChatId, recipientIds, message, {
        attachments: [keyboard],
    });
    for (const { admin_id, message_mid } of sent) {
        commentStore_1.commentStore.saveNotificationMid(input.commentId, admin_id, message_mid);
    }
}
/**
 * Шлёт пользователю DM об ответе канала на комментарий (кнопка «Открыть»). Ошибки доставки логируются.
 */
async function notifyUserAboutMiniappReply(bot, input) {
    if (!(0, postStore_1.isMiniAppOpenUrlConfigured)()) {
        logger_1.logger.warn('notifyUserAboutMiniappReply: BOT_NICKNAME / MINI_APP_URL not set for Mini App links');
        return;
    }
    const openUrl = (0, postStore_1.buildMiniAppUrl)(input.postId, input.channelChatId);
    const keyboard = max_bot_api_1.Keyboard.inlineKeyboard([[max_bot_api_1.Keyboard.button.link('Открыть', openUrl)]]);
    const postExcerpt = preview80(input.postText);
    const message = `💬 Вам ответили на комментарий
Пост: «${postExcerpt}»
Ваш комментарий: ${input.userCommentText}
Ответ канала: ${input.adminReplyText}`;
    try {
        await bot.api.sendMessageToUser(input.userId, message, { attachments: [keyboard] });
        logger_1.logger.info('notifyUserAboutMiniappReply: delivered', { userId: input.userId });
    }
    catch (err) {
        logger_1.logger.warn('notifyUserAboutMiniappReply: could not deliver', {
            userId: input.userId,
            err,
        });
    }
}
//# sourceMappingURL=notificationService.js.map