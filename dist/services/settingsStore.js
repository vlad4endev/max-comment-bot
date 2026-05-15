"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsStore = void 0;
const channelNotifyLinkStore_1 = require("./channelNotifyLinkStore");
const logger_1 = require("../utils/logger");
/**
 * Links a user to a channel for admin notifications (delegates to {@link channelNotifyLinkStore}).
 */
exports.settingsStore = {
    linkUserToChannel(userId, channelChatId) {
        logger_1.logger.info('DEBUG linkUserToChannel', {
            userId,
            channelChatId,
            currentLinked: channelNotifyLinkStore_1.channelNotifyLinkStore.getUserIdsForChannel(channelChatId),
        });
        channelNotifyLinkStore_1.channelNotifyLinkStore.register(userId, channelChatId);
    },
    forcePersist() {
        return channelNotifyLinkStore_1.channelNotifyLinkStore.forcePersist();
    },
};
//# sourceMappingURL=settingsStore.js.map