"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearTelegramAdminJoinNotified = clearTelegramAdminJoinNotified;
exports.hasTelegramAdminJoinNotified = hasTelegramAdminJoinNotified;
exports.markTelegramAdminJoinNotified = markTelegramAdminJoinNotified;
const database_1 = require("../db/database");
/** Каналы TG, для которых уже отправили уведомление «бот подключён с правами админа». */
const channelsAdminJoinNotified = new Set();
let cacheLoaded = false;
function normalizeChatId(channelChatId) {
    return String(channelChatId).trim();
}
function ensureCacheLoaded() {
    if (cacheLoaded) {
        return;
    }
    const rows = (0, database_1.getDb)()
        .prepare('SELECT chat_id FROM tg_channels WHERE admin_join_notified = 1')
        .all();
    for (const row of rows) {
        channelsAdminJoinNotified.add(normalizeChatId(row.chat_id));
    }
    cacheLoaded = true;
}
function clearTelegramAdminJoinNotified(channelChatId) {
    ensureCacheLoaded();
    const id = normalizeChatId(channelChatId);
    channelsAdminJoinNotified.delete(id);
    (0, database_1.getDb)()
        .prepare('UPDATE tg_channels SET admin_join_notified = 0 WHERE chat_id = ?')
        .run(id);
}
function hasTelegramAdminJoinNotified(channelChatId) {
    ensureCacheLoaded();
    return channelsAdminJoinNotified.has(normalizeChatId(channelChatId));
}
function markTelegramAdminJoinNotified(channelChatId) {
    ensureCacheLoaded();
    const id = normalizeChatId(channelChatId);
    channelsAdminJoinNotified.add(id);
    (0, database_1.getDb)()
        .prepare('UPDATE tg_channels SET admin_join_notified = 1 WHERE chat_id = ?')
        .run(id);
}
//# sourceMappingURL=telegramChannelAdminJoinNotified.js.map