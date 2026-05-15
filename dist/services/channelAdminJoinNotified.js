"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearAdminJoinNotifiedForChannel = clearAdminJoinNotifiedForChannel;
exports.hasChannelAdminJoinNotified = hasChannelAdminJoinNotified;
exports.markChannelAdminJoinNotified = markChannelAdminJoinNotified;
/**
 * In-memory: we already sent the "bot joined with admin rights" admin notification for this chat.
 * Cleared when a channel is fully disconnected. Survives pending→admin transitions without duplicate notify.
 */
const channelsAdminJoinNotified = new Set();
function clearAdminJoinNotifiedForChannel(channelChatId) {
    channelsAdminJoinNotified.delete(channelChatId);
}
function hasChannelAdminJoinNotified(channelChatId) {
    return channelsAdminJoinNotified.has(channelChatId);
}
function markChannelAdminJoinNotified(channelChatId) {
    channelsAdminJoinNotified.add(channelChatId);
}
//# sourceMappingURL=channelAdminJoinNotified.js.map