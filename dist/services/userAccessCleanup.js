"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fullyRemoveUserFromBot = fullyRemoveUserFromBot;
const channelNotifyLinkStore_1 = require("./channelNotifyLinkStore");
const stateManager_1 = require("./stateManager");
const subscriberStore_1 = require("./subscriberStore");
const userMiniappSettingsStore_1 = require("./userMiniappSettingsStore");
/**
 * Fully removes user access to this bot from local storage-backed stores.
 */
function fullyRemoveUserFromBot(userId) {
    subscriberStore_1.subscriberStore.removeSubscriber(userId);
    channelNotifyLinkStore_1.channelNotifyLinkStore.removeAllForUser(userId);
    userMiniappSettingsStore_1.userMiniappSettingsStore.removeUser(userId);
    stateManager_1.stateManager.clearAllStatesForUser(userId);
    stateManager_1.stateManager.clearUserPrivateChatId(userId);
}
//# sourceMappingURL=userAccessCleanup.js.map