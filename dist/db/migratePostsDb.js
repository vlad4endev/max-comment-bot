"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateAutopostsFromBotDb = migrateAutopostsFromBotDb;
const database_1 = require("./database");
const postsDatabase_1 = require("./postsDatabase");
const logger_1 = require("../utils/logger");
/**
 * Переносит autoposts из bot.db в posts.db (однократно).
 * После успешного переноса таблица autoposts удаляется из bot.db.
 */
function migrateAutopostsFromBotDb() {
    if ((0, postsDatabase_1.getPostsDbMeta)('migrated_from_bot_db') === '1') {
        return;
    }
    const postsDb = (0, postsDatabase_1.getPostsDb)();
    const existing = postsDb.prepare('SELECT COUNT(*) AS n FROM autoposts').get().n;
    if (existing > 0) {
        (0, postsDatabase_1.setPostsDbMeta)('migrated_from_bot_db', '1');
        return;
    }
    const botDb = (0, database_1.getDb)();
    const table = botDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'autoposts'")
        .get();
    if (!table) {
        (0, postsDatabase_1.setPostsDbMeta)('migrated_from_bot_db', '1');
        return;
    }
    const rows = botDb.prepare('SELECT * FROM autoposts ORDER BY created_at ASC').all();
    if (rows.length === 0) {
        botDb.exec('DROP TABLE IF EXISTS autoposts');
        botDb.exec('DROP INDEX IF EXISTS idx_autoposts_due');
        (0, postsDatabase_1.setPostsDbMeta)('migrated_from_bot_db', '1');
        return;
    }
    const insert = postsDb.prepare(`INSERT INTO autoposts (
      id, platform, target_channel_id, channel_title, text, media_json,
      inline_button_json, status, schedule_type, scheduled_at,
      recurring_time, weekdays_json, timezone, last_sent_at, last_error,
      sent_count, created_at, updated_at
    ) VALUES (
      ?, 'telegram', ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?
    )`);
    const upsertChannel = postsDb.prepare(`INSERT INTO post_channels (id, platform, title, is_active, created_at, updated_at)
     VALUES (?, 'telegram', ?, 1, datetime('now'), datetime('now'))
     ON CONFLICT(platform, id) DO UPDATE SET
       title = COALESCE(excluded.title, post_channels.title),
       updated_at = datetime('now')`);
    const tx = postsDb.transaction(() => {
        for (const row of rows) {
            const status = row.status === 'draft' ||
                row.status === 'active' ||
                row.status === 'sent' ||
                row.status === 'paused' ||
                row.status === 'failed'
                ? row.status
                : 'active';
            insert.run(row.id, row.target_channel_id, row.channel_title, row.text, row.media_json || '[]', row.inline_button_json, status, row.schedule_type === 'recurring' ? 'recurring' : 'once', row.scheduled_at, row.recurring_time, row.weekdays_json, row.timezone || 'Europe/Moscow', row.last_sent_at, row.last_error, row.sent_count, row.created_at, row.updated_at);
            upsertChannel.run(row.target_channel_id, row.channel_title);
        }
    });
    tx();
    botDb.exec('DROP TABLE IF EXISTS autoposts');
    botDb.exec('DROP INDEX IF EXISTS idx_autoposts_due');
    (0, postsDatabase_1.setPostsDbMeta)('migrated_from_bot_db', '1');
    logger_1.logger.info('migratePostsDb: перенесены автопосты из bot.db в posts.db', { count: rows.length });
}
//# sourceMappingURL=migratePostsDb.js.map