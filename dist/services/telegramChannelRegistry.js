"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.telegramChannelRegistry = exports.TelegramChannelRegistry = void 0;
const database_1 = require("../db/database");
class TelegramChannelRegistry {
    statements = null;
    saveChannel(input) {
        const chatId = String(input.chatId).trim();
        if (!/^-?\d+$/.test(chatId)) {
            return;
        }
        const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : null;
        const username = typeof input.username === 'string' && input.username.trim() !== ''
            ? input.username.trim()
            : null;
        const type = typeof input.type === 'string' && input.type.trim() !== '' ? input.type.trim() : 'channel';
        this.getStatements().upsert.run(chatId, title, username, type, input.botIsAdmin ? 1 : 0);
    }
    getChannel(chatId) {
        const id = String(chatId).trim();
        const row = this.getStatements().get.get(id);
        if (!row) {
            return null;
        }
        return {
            chat_id: row.chat_id,
            title: row.title,
            username: row.username,
            type: row.type,
            bot_is_admin: row.bot_is_admin === 1,
            updated_at: row.updated_at,
        };
    }
    getAllChannels() {
        const rows = this.getStatements().all.all();
        return rows.map((row) => ({
            chat_id: row.chat_id,
            title: row.title,
            username: row.username,
            type: row.type,
            bot_is_admin: row.bot_is_admin === 1,
            updated_at: row.updated_at,
        }));
    }
    getStatements() {
        if (this.statements) {
            return this.statements;
        }
        const db = (0, database_1.getDb)();
        this.statements = {
            upsert: db.prepare(`
        INSERT INTO tg_channels (chat_id, title, username, type, bot_is_admin, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(chat_id) DO UPDATE SET
          title = COALESCE(excluded.title, tg_channels.title),
          username = COALESCE(excluded.username, tg_channels.username),
          type = COALESCE(excluded.type, tg_channels.type),
          bot_is_admin = excluded.bot_is_admin,
          updated_at = datetime('now')
      `),
            all: db.prepare(`
        SELECT chat_id, title, username, type, bot_is_admin, updated_at
        FROM tg_channels
        ORDER BY title COLLATE NOCASE ASC, chat_id ASC
      `),
            get: db.prepare(`
        SELECT chat_id, title, username, type, bot_is_admin, updated_at
        FROM tg_channels
        WHERE chat_id = ?
      `),
        };
        return this.statements;
    }
}
exports.TelegramChannelRegistry = TelegramChannelRegistry;
exports.telegramChannelRegistry = new TelegramChannelRegistry();
//# sourceMappingURL=telegramChannelRegistry.js.map