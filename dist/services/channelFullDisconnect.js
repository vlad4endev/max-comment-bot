"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveRegisteredChannelAccess = resolveRegisteredChannelAccess;
exports.purgeAllChannelData = purgeAllChannelData;
exports.fullyDisconnectRegisteredChannel = fullyDisconnectRegisteredChannel;
exports.maybePruneRegisteredChannelsNotAccessibleByBot = maybePruneRegisteredChannelsNotAccessibleByBot;
exports.pruneRegisteredChannelsNotAccessibleByBot = pruneRegisteredChannelsNotAccessibleByBot;
const adminPanelState_1 = require("../api/adminPanelState");
const logger_1 = require("../utils/logger");
const botChannelMembership_1 = require("./botChannelMembership");
const channelNotifyLinkStore_1 = require("./channelNotifyLinkStore");
const channelRegistry_1 = require("./channelRegistry");
const channelSettingsStore_1 = require("./channelSettingsStore");
const channelAdminJoinNotified_1 = require("./channelAdminJoinNotified");
const channelPoller_1 = require("./channelPoller");
const commentButtonRetryQueue_1 = require("./commentButtonRetryQueue");
const commentStore_1 = require("./commentStore");
const integrationsStore_1 = require("./integrationsStore");
const notificationService_1 = require("./notificationService");
const postStore_1 = require("./postStore");
const settingsStore_1 = require("./settingsStore");
const stateManager_1 = require("./stateManager");
const userAccessCleanup_1 = require("./userAccessCleanup");
/**
 * Live check: chat exists for the bot and the bot is still a member with admin/owner rights.
 */
async function resolveRegisteredChannelAccess(bot, chatId) {
    try {
        await bot.api.getChat(chatId);
    }
    catch (err) {
        logger_1.logger.debug('resolveRegisteredChannelAccess: getChat failed', { chatId, err });
        return 'chat_unreachable';
    }
    const member = await (0, botChannelMembership_1.fetchBotChatMember)(bot, chatId);
    if (!member) {
        return 'bot_not_in_chat';
    }
    if (!(0, botChannelMembership_1.isBotAdminOrOwner)(member)) {
        return 'bot_not_admin';
    }
    return 'ok';
}
function collectUsersToResetAfterChannelPurge(chatId) {
    const ids = new Set();
    for (const userId of channelNotifyLinkStore_1.channelNotifyLinkStore.getUserIdsForChannel(chatId)) {
        ids.add(userId);
    }
    for (const userId of stateManager_1.stateManager.getUserIdsPendingJoinToChannel(chatId)) {
        ids.add(userId);
    }
    return [...ids];
}
/**
 * Сбрасывает пользователей, у которых не осталось привязок к каналам после удаления этого канала.
 */
function resetUsersOrphanedAfterChannelPurge(candidateUserIds) {
    for (const userId of candidateUserIds) {
        if (settingsStore_1.settingsStore.getLinkedChannels(userId).length > 0) {
            continue;
        }
        (0, userAccessCleanup_1.fullyRemoveUserFromBot)(userId);
        logger_1.logger.info('channelFullDisconnect: user reset after channel purge', { userId });
    }
}
/**
 * Удаляет все локальные данные канала (SQLite, JSON, in-memory), не трогая глобальных подписчиков бота.
 */
async function purgeAllChannelData(chatId) {
    const linkedBefore = collectUsersToResetAfterChannelPurge(chatId);
    stateManager_1.stateManager.clearChannelPendingAdminRights(chatId);
    stateManager_1.stateManager.clearAllStatesInChat(chatId);
    stateManager_1.stateManager.clearPendingAdminJoinsForChannel(chatId);
    (0, channelAdminJoinNotified_1.clearAdminJoinNotifiedForChannel)(chatId);
    (0, channelPoller_1.clearChannelPollerErrors)(chatId);
    (0, commentButtonRetryQueue_1.clearCommentButtonRetriesForChannel)(chatId);
    channelNotifyLinkStore_1.channelNotifyLinkStore.removeAllForChannel(chatId);
    channelSettingsStore_1.channelSettingsStore.removeChannel(chatId);
    const postIds = postStore_1.postStore.removePostsForChatId(chatId);
    commentStore_1.commentStore.removeCommentsByPostIds(new Set(postIds));
    channelRegistry_1.channelRegistry.removeChannel(chatId);
    try {
        await channelNotifyLinkStore_1.channelNotifyLinkStore.forcePersist();
    }
    catch (err) {
        logger_1.logger.warn('channelFullDisconnect: forcePersist notify links failed', { chatId, err });
    }
    try {
        await (0, adminPanelState_1.purgeChannelFromAdminState)(chatId);
    }
    catch (err) {
        logger_1.logger.warn('channelFullDisconnect: purgeChannelFromAdminState failed', { chatId, err });
    }
    try {
        const flowsRemoved = await integrationsStore_1.integrationsStore.removeFlowsForMaxChatId(chatId);
        if (flowsRemoved > 0) {
            logger_1.logger.info('channelFullDisconnect: integration flows removed', { chatId, flowsRemoved });
        }
    }
    catch (err) {
        logger_1.logger.warn('channelFullDisconnect: removeFlowsForMaxChatId failed', { chatId, err });
    }
    resetUsersOrphanedAfterChannelPurge(linkedBefore);
    logger_1.logger.info('channelFullDisconnect: purgeAllChannelData completed', { chatId });
}
/**
 * Removes all bot-side data for a registered channel (registry, posts, comments, notify links)
 * and optionally notifies channel admins in DM before links are dropped.
 */
async function fullyDisconnectRegisteredChannel(bot, chatId, reason) {
    const reg = channelRegistry_1.channelRegistry.getChannel(chatId);
    const displayTitle = reg?.title?.trim() || 'без названия';
    const shouldNotify = reason !== 'registry_stale_removed';
    let recipientIds = [];
    if (shouldNotify && reg) {
        try {
            recipientIds = await (0, notificationService_1.collectAdminNotifyRecipientIds)(bot, chatId);
        }
        catch (err) {
            logger_1.logger.warn('channelFullDisconnect: collect recipients failed', { chatId, err });
        }
    }
    if (reason === 'manual_admin_panel') {
        try {
            await bot.api.leaveChat(chatId);
            logger_1.logger.info('channelFullDisconnect: bot left channel (manual disconnect)', { chatId });
        }
        catch (err) {
            logger_1.logger.warn('channelFullDisconnect: leaveChat failed (manual disconnect)', { chatId, err });
        }
    }
    await purgeAllChannelData(chatId);
    if (shouldNotify && recipientIds.length > 0) {
        const reasonBlock = reason === 'manual_admin_panel'
            ? 'Канал отключён вручную через панель SuperAdmin.\n\nCommentBot покинул канал. Все данные канала (посты, комментарии, привязки пользователей) удалены из базы.\n\nЧтобы снова подключить комментарии, добавьте бота в канал заново и выдайте права администратора.'
            : reason === 'lost_admin_rights'
                ? 'С бота сняли права администратора в канале. Без них CommentBot не может показывать кнопки комментариев и обрабатывать обсуждения.\n\nКанал отключён: все данные канала и привязки пользователей удалены из базы.\n\nЧтобы снова включить комментарии, добавьте бота заново и выдайте права администратора.'
                : 'Бот удалён из канала или потерял к нему доступ.\n\nКанал отключён: все данные канала и привязки пользователей удалены из базы.';
        const message = `🔌 CommentBot отключён\n` +
            `Канал: «${displayTitle}»\n` +
            `ID чата: ${chatId}\n\n` +
            reasonBlock;
        await (0, notificationService_1.deliverAdminNotifications)(bot, chatId, recipientIds, message);
    }
    if (!reg) {
        logger_1.logger.info('channelFullDisconnect: channel was not in registry; sidecar data purged', {
            chatId,
            reason,
        });
        return false;
    }
    logger_1.logger.info('channelFullDisconnect: completed', { chatId, reason, notified: shouldNotify });
    return true;
}
const PRUNE_TTL_MS = 90_000;
let lastPruneAt = 0;
let pruneInFlight = null;
/**
 * Периодическая проверка доступа к каналам (не чаще раза в ~90 с), чтобы админ-панель
 * не блокировалась на MAX API при каждом запросе.
 */
async function maybePruneRegisteredChannelsNotAccessibleByBot(bot, options) {
    const force = options?.force === true;
    const now = Date.now();
    if (!force && now - lastPruneAt < PRUNE_TTL_MS) {
        return;
    }
    if (pruneInFlight) {
        await pruneInFlight;
        if (!force && Date.now() - lastPruneAt < PRUNE_TTL_MS) {
            return;
        }
    }
    pruneInFlight = pruneRegisteredChannelsNotAccessibleByBot(bot)
        .then(() => {
        lastPruneAt = Date.now();
    })
        .finally(() => {
        pruneInFlight = null;
    });
    await pruneInFlight;
}
/**
 * Удаляет из реестра каналы, к которым бот больше не имеет доступа
 * (чат удалён, бот выгнан; без прав админа остаются для статуса «ожидает прав»).
 */
async function pruneRegisteredChannelsNotAccessibleByBot(bot) {
    const snapshot = [...channelRegistry_1.channelRegistry.getAllChannels()].filter((c) => c.type === 'channel');
    for (const c of snapshot) {
        if (channelRegistry_1.channelRegistry.getChannel(c.chat_id) === null) {
            continue;
        }
        const access = await resolveRegisteredChannelAccess(bot, c.chat_id);
        if (access === 'chat_unreachable') {
            logger_1.logger.warn('pruneRegisteredChannelsNotAccessibleByBot: chat unreachable, removing', {
                chatId: c.chat_id,
            });
            await fullyDisconnectRegisteredChannel(bot, c.chat_id, 'registry_stale_removed');
            continue;
        }
        if (access === 'bot_not_in_chat') {
            logger_1.logger.warn('pruneRegisteredChannelsNotAccessibleByBot: bot not in chat, removing', {
                chatId: c.chat_id,
            });
            await fullyDisconnectRegisteredChannel(bot, c.chat_id, 'removed_from_chat');
            continue;
        }
        if (access === 'ok') {
            stateManager_1.stateManager.clearChannelPendingAdminRights(c.chat_id);
        }
    }
}
//# sourceMappingURL=channelFullDisconnect.js.map