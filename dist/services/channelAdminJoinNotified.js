"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearAdminJoinNotifiedForChannel = clearAdminJoinNotifiedForChannel;
exports.hasChannelAdminJoinNotified = hasChannelAdminJoinNotified;
exports.markChannelAdminJoinNotified = markChannelAdminJoinNotified;
const database_1 = require("../db/database");
/**
 * In-memory cache backed by SQLite: we already sent the "bot joined with admin rights"
 * admin notification for this chat. Cleared when a channel is fully disconnected.
 */
const channelsAdminJoinNotified = new Set();
let cacheLoaded = false;
function ensureCacheLoaded() {
    if (cacheLoaded) {
        return;
    }
    const rows = (0, database_1.getDb)()
        .prepare('SELECT chat_id FROM channels WHERE admin_join_notified = 1')
        .all();
    for (const row of rows) {
        channelsAdminJoinNotified.add(row.chat_id);
    }
    cacheLoaded = true;
}
function clearAdminJoinNotifiedForChannel(channelChatId) {
    ensureCacheLoaded();
    channelsAdminJoinNotified.delete(channelChatId);
    (0, database_1.getDb)()
        .prepare('UPDATE channels SET admin_join_notified = 0 WHERE chat_id = ?')
        .run(channelChatId);
}
function hasChannelAdminJoinNotified(channelChatId) {
    ensureCacheLoaded();
    return channelsAdminJoinNotified.has(channelChatId);
}
function markChannelAdminJoinNotified(channelChatId) {
    ensureCacheLoaded();
    channelsAdminJoinNotified.add(channelChatId);
    (0, database_1.getDb)()
        .prepare('UPDATE channels SET admin_join_notified = 1 WHERE chat_id = ?')
        .run(channelChatId);
}
//# sourceMappingURL=channelAdminJoinNotified.js.map