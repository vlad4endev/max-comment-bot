"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.telegramBotUserStore = exports.TelegramBotUserStore = void 0;
const database_1 = require("../db/database");
function isPositiveInt(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
class TelegramBotUserStore {
    statements = null;
    markStarted(profile) {
        if (!isPositiveInt(profile.id)) {
            return;
        }
        const username = typeof profile.username === 'string' ? profile.username.trim() : '';
        const firstName = typeof profile.first_name === 'string' ? profile.first_name.trim() : '';
        const lastName = typeof profile.last_name === 'string' ? profile.last_name.trim() : '';
        this.getStatements().upsertStarted.run(profile.id, username || null, firstName || null, lastName || null);
    }
    hasStarted(userId) {
        return this.getStartedIds([userId]).has(userId);
    }
    getStartedIds(userIds) {
        const normalized = [...new Set(userIds.filter((id) => isPositiveInt(id)))];
        if (normalized.length === 0) {
            return new Set();
        }
        const placeholders = normalized.map(() => '?').join(', ');
        const stmt = (0, database_1.getDb)().prepare(`SELECT user_id FROM tg_bot_users WHERE user_id IN (${placeholders}) AND started = 1`);
        const rows = stmt.all(...normalized);
        return new Set(rows.map((row) => row.user_id));
    }
    getStatements() {
        if (this.statements) {
            return this.statements;
        }
        const db = (0, database_1.getDb)();
        this.statements = {
            upsertStarted: db.prepare(`
        INSERT INTO tg_bot_users (
          user_id, username, first_name, last_name, started, started_at, last_seen_at
        ) VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))
        ON CONFLICT(user_id) DO UPDATE SET
          username = COALESCE(excluded.username, tg_bot_users.username),
          first_name = COALESCE(excluded.first_name, tg_bot_users.first_name),
          last_name = COALESCE(excluded.last_name, tg_bot_users.last_name),
          started = 1,
          started_at = COALESCE(tg_bot_users.started_at, datetime('now')),
          last_seen_at = datetime('now')
      `),
        };
        return this.statements;
    }
}
exports.TelegramBotUserStore = TelegramBotUserStore;
exports.telegramBotUserStore = new TelegramBotUserStore();
//# sourceMappingURL=telegramBotUserStore.js.map