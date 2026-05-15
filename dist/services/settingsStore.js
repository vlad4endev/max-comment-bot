"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsStore = void 0;
const channelNotifyLinkStore_1 = require("./channelNotifyLinkStore");
/**
 * Links a user to a channel for admin notifications (delegates to {@link channelNotifyLinkStore}).
 */
exports.settingsStore = {
    linkUserToChannel(userId, channelChatId) {
        channelNotifyLinkStore_1.channelNotifyLinkStore.register(userId, channelChatId);
    },
};
//# sourceMappingURL=settingsStore.js.map