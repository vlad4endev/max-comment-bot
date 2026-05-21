"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.telegramChannelNotifyLinkStore = exports.TelegramChannelNotifyLinkStore = void 0;
const database_1 = require("../db/database");
const logger_1 = require("../utils/logger");
class TelegramChannelNotifyLinkStore {
    statements = null;
    register(userId, channelChatId) {
        if (!Number.isInteger(userId) || userId <= 0) {
            return;
        }
        const chatId = String(channelChatId).trim();
        if (!/^-?\d+$/.test(chatId)) {
            return;
        }
        if (this.isLinked(userId, chatId)) {
            return;
        }
        this.getStatements().register.run(userId, chatId);
        logger_1.logger.info('telegramChannelNotifyLinkStore: registered', { userId, channelChatId: chatId });
    }
    isLinked(userId, channelChatId) {
        const chatId = String(channelChatId).trim();
        const row = this.getStatements().isLinked.get(userId, chatId);
        return (row?.n ?? 0) > 0;
    }
    getUserIdsForChannel(channelChatId) {
        const chatId = String(channelChatId).trim();
        const rows = this.getStatements().listForChannel.all(chatId);
        return rows.map((r) => r.user_id);
    }
    getLinkedChannels(userId) {
        const rows = this.getStatements().listForUser.all(userId);
        return rows.map((r) => r.channel_chat_id);
    }
    removeUserFromChannel(userId, channelChatId) {
        const chatId = String(channelChatId).trim();
        this.getStatements().removeUserFromChannel.run(userId, chatId);
    }
    removeAllForUser(userId) {
        this.getStatements().removeAllForUser.run(userId);
    }
    removeAllForChannel(channelChatId) {
        const chatId = String(channelChatId).trim();
        this.getStatements().removeAllForChannel.run(chatId);
    }
    getStatements() {
        if (this.statements) {
            return this.statements;
        }
        const db = (0, database_1.getDb)();
        this.statements = {
            register: db.prepare(`
        INSERT INTO tg_channel_notify_links (user_id, channel_chat_id, joined_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(user_id, channel_chat_id) DO NOTHING
      `),
            isLinked: db.prepare(`
        SELECT COUNT(*) AS n
        FROM tg_channel_notify_links
        WHERE user_id = ? AND channel_chat_id = ?
      `),
            listForChannel: db.prepare(`
        SELECT user_id
        FROM tg_channel_notify_links
        WHERE channel_chat_id = ?
        ORDER BY user_id ASC
      `),
            listForUser: db.prepare(`
        SELECT channel_chat_id
        FROM tg_channel_notify_links
        WHERE user_id = ?
        ORDER BY channel_chat_id ASC
      `),
            removeUserFromChannel: db.prepare(`
        DELETE FROM tg_channel_notify_links
        WHERE user_id = ? AND channel_chat_id = ?
      `),
            removeAllForUser: db.prepare(`
        DELETE FROM tg_channel_notify_links WHERE user_id = ?
      `),
            removeAllForChannel: db.prepare(`
        DELETE FROM tg_channel_notify_links WHERE channel_chat_id = ?
      `),
        };
        return this.statements;
    }
}
exports.TelegramChannelNotifyLinkStore = TelegramChannelNotifyLinkStore;
exports.telegramChannelNotifyLinkStore = new TelegramChannelNotifyLinkStore();
//# sourceMappingURL=telegramChannelNotifyLinkStore.js.map