"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.telegramChannelActivationState = void 0;
/** Каналы TG, ожидающие выдачи боту прав администратора или повторного /connect. */
const pendingAdminChannelIds = new Set();
/** userId → channelChatId: ожидание первого сообщения после jointg deep link. */
const pendingAdminJoinByUserId = new Map();
function normalizeChatId(channelChatId) {
    return String(channelChatId).trim();
}
exports.telegramChannelActivationState = {
    markChannelPendingAdminRights(channelChatId) {
        pendingAdminChannelIds.add(normalizeChatId(channelChatId));
    },
    clearChannelPendingAdminRights(channelChatId) {
        pendingAdminChannelIds.delete(normalizeChatId(channelChatId));
    },
    isChannelPendingAdminRights(channelChatId) {
        return pendingAdminChannelIds.has(normalizeChatId(channelChatId));
    },
    getPendingAdminChannelIds() {
        return [...pendingAdminChannelIds];
    },
    setPendingAdminJoin(userId, channelChatId) {
        pendingAdminJoinByUserId.set(userId, normalizeChatId(channelChatId));
    },
    getPendingAdminJoin(userId) {
        return pendingAdminJoinByUserId.get(userId);
    },
    clearPendingAdminJoinForUser(userId) {
        pendingAdminJoinByUserId.delete(userId);
    },
    clearPendingAdminJoinsForChannel(channelChatId) {
        const target = normalizeChatId(channelChatId);
        for (const [userId, ch] of pendingAdminJoinByUserId) {
            if (ch === target) {
                pendingAdminJoinByUserId.delete(userId);
            }
        }
    },
};
//# sourceMappingURL=telegramChannelActivationState.js.map