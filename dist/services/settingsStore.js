"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsStore = void 0;
const channelNotifyLinkStore_1 = require("./channelNotifyLinkStore");
const logger_1 = require("../utils/logger");
/**
 * Links a user to a channel for admin notifications (delegates to {@link channelNotifyLinkStore}).
 */
exports.settingsStore = {
    /** User ids linked to this channel for admin / comment notifications (from {@link channelNotifyLinkStore}). */
    getUsersLinkedToChannel(channelChatId) {
        return channelNotifyLinkStore_1.channelNotifyLinkStore.getUserIdsForChannel(channelChatId);
    },
    getLinkedChannels(userId) {
        const seen = new Set();
        const channels = [];
        for (const link of channelNotifyLinkStore_1.channelNotifyLinkStore.getAllLinks()) {
            if (link.user_id !== userId || seen.has(link.channel_chat_id)) {
                continue;
            }
            seen.add(link.channel_chat_id);
            channels.push(link.channel_chat_id);
        }
        return channels;
    },
    linkUserToChannel(userId, channelChatId) {
        const linkedChannelsBefore = this.getLinkedChannels(userId);
        const channelUsersBefore = this.getUsersLinkedToChannel(channelChatId);
        logger_1.logger.info('settingsStore.linkUserToChannel called', {
            userId,
            chatId: channelChatId,
            wasAlreadyLinked: linkedChannelsBefore.includes(channelChatId),
            linkedChannelsBefore,
            channelUsersBefore,
        });
        channelNotifyLinkStore_1.channelNotifyLinkStore.register(userId, channelChatId);
        this.forcePersist().catch((err) => {
            logger_1.logger.error('settingsStore.linkUserToChannel forcePersist failed', { err, userId, chatId: channelChatId });
        });
        logger_1.logger.info('settingsStore.linkUserToChannel saved', {
            userId,
            linkedChannelsAfter: this.getLinkedChannels(userId),
            channelUsersAfter: this.getUsersLinkedToChannel(channelChatId),
        });
    },
    forcePersist() {
        return channelNotifyLinkStore_1.channelNotifyLinkStore.forcePersist();
    },
};
//# sourceMappingURL=settingsStore.js.map