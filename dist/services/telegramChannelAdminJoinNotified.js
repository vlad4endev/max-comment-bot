"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearTelegramAdminJoinNotified = clearTelegramAdminJoinNotified;
exports.hasTelegramAdminJoinNotified = hasTelegramAdminJoinNotified;
exports.markTelegramAdminJoinNotified = markTelegramAdminJoinNotified;
/** Каналы TG, для которых уже отправили уведомление «бот подключён с правами админа». */
const channelsAdminJoinNotified = new Set();
function normalizeChatId(channelChatId) {
    return String(channelChatId).trim();
}
function clearTelegramAdminJoinNotified(channelChatId) {
    channelsAdminJoinNotified.delete(normalizeChatId(channelChatId));
}
function hasTelegramAdminJoinNotified(channelChatId) {
    return channelsAdminJoinNotified.has(normalizeChatId(channelChatId));
}
function markTelegramAdminJoinNotified(channelChatId) {
    channelsAdminJoinNotified.add(normalizeChatId(channelChatId));
}
//# sourceMappingURL=telegramChannelAdminJoinNotified.js.map