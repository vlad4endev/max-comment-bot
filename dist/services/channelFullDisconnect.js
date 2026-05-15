"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fullyDisconnectRegisteredChannel = fullyDisconnectRegisteredChannel;
exports.pruneRegisteredChannelsNotAccessibleByBot = pruneRegisteredChannelsNotAccessibleByBot;
const logger_1 = require("../utils/logger");
const channelNotifyLinkStore_1 = require("./channelNotifyLinkStore");
const channelRegistry_1 = require("./channelRegistry");
const channelAdminJoinNotified_1 = require("./channelAdminJoinNotified");
const commentStore_1 = require("./commentStore");
const notificationService_1 = require("./notificationService");
const postStore_1 = require("./postStore");
const stateManager_1 = require("./stateManager");
/**
 * Removes all bot-side data for a registered channel (registry, posts, comments, notify links)
 * and optionally notifies channel admins in DM before links are dropped.
 */
async function fullyDisconnectRegisteredChannel(bot, chatId, reason) {
    const reg = channelRegistry_1.channelRegistry.getChannel(chatId);
    if (!reg) {
        logger_1.logger.info('channelFullDisconnect: channel not in registry, skipping', { chatId, reason });
        return false;
    }
    const displayTitle = reg.title?.trim() || 'без названия';
    const shouldNotify = reason !== 'manual_admin_panel' && reason !== 'registry_stale_removed';
    let recipientIds = [];
    if (shouldNotify) {
        try {
            recipientIds = await (0, notificationService_1.collectAdminNotifyRecipientIds)(bot, chatId);
        }
        catch (err) {
            logger_1.logger.warn('channelFullDisconnect: collect recipients failed', { chatId, err });
        }
    }
    stateManager_1.stateManager.clearChannelPendingAdminRights(chatId);
    (0, channelAdminJoinNotified_1.clearAdminJoinNotifiedForChannel)(chatId);
    channelNotifyLinkStore_1.channelNotifyLinkStore.removeAllForChannel(chatId);
    const postIds = postStore_1.postStore.removePostsForChatId(chatId);
    commentStore_1.commentStore.removeCommentsByPostIds(new Set(postIds));
    channelRegistry_1.channelRegistry.removeChannel(chatId);
    try {
        await channelNotifyLinkStore_1.channelNotifyLinkStore.forcePersist();
    }
    catch (err) {
        logger_1.logger.warn('channelFullDisconnect: forcePersist notify links failed', { chatId, err });
    }
    if (shouldNotify && recipientIds.length > 0) {
        const reasonBlock = reason === 'lost_admin_rights'
            ? 'С бота сняли права администратора в канале. Без них CommentBot не может показывать кнопки комментариев и обрабатывать обсуждения.\n\nКанал отключён: посты и комментарии из базы удалены, связь с каналом сброшена.\n\nЧтобы снова включить комментарии, добавьте бота заново и выдайте права администратора.'
            : 'Бот удалён из канала или потерял к нему доступ.\n\nКанал отключён: посты и комментарии из базы удалены, связь с каналом сброшена.';
        const message = `🔌 CommentBot отключён\n` +
            `Канал: «${displayTitle}»\n` +
            `ID чата: ${chatId}\n\n` +
            reasonBlock;
        await (0, notificationService_1.deliverAdminNotifications)(bot, chatId, recipientIds, message);
    }
    logger_1.logger.info('channelFullDisconnect: completed', { chatId, reason, notified: shouldNotify });
    return true;
}
/**
 * Удаляет из реестра каналы типа `channel`, для которых {@link Bot.api.getChat} больше не проходит
 * (бот выгнан, чат удалён и т.п.), чтобы админка и поллер не показывали «мёртвые» записи.
 */
async function pruneRegisteredChannelsNotAccessibleByBot(bot) {
    const snapshot = [...channelRegistry_1.channelRegistry.getAllChannels()].filter((c) => c.type === 'channel');
    for (const c of snapshot) {
        if (channelRegistry_1.channelRegistry.getChannel(c.chat_id) === null) {
            continue;
        }
        try {
            await bot.api.getChat(c.chat_id);
        }
        catch (err) {
            logger_1.logger.warn('pruneRegisteredChannelsNotAccessibleByBot: getChat failed, removing', {
                chatId: c.chat_id,
                err,
            });
            await fullyDisconnectRegisteredChannel(bot, c.chat_id, 'registry_stale_removed');
        }
    }
}
//# sourceMappingURL=channelFullDisconnect.js.map