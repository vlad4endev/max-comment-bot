"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.POSTS_DB_PATH = void 0;
exports.getPostsDb = getPostsDb;
exports.getPostsDbMeta = getPostsDbMeta;
exports.setPostsDbMeta = setPostsDbMeta;
exports.closePostsDb = closePostsDb;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
function getLogger() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../utils/logger').logger;
}
const DATA_DIR = node_path_1.default.resolve(__dirname, '../../data');
exports.POSTS_DB_PATH = node_path_1.default.join(DATA_DIR, 'posts.db');
let postsDb = null;
function getPostsDb() {
    if (postsDb) {
        return postsDb;
    }
    node_fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
    const instance = new better_sqlite3_1.default(exports.POSTS_DB_PATH);
    instance.pragma('journal_mode = WAL');
    instance.pragma('synchronous = NORMAL');
    instance.pragma('foreign_keys = ON');
    initPostsSchema(instance);
    postsDb = instance;
    return instance;
}
function initPostsSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS posts_db_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    /** Единый реестр каналов для публикации (Telegram + MAX) */
    CREATE TABLE IF NOT EXISTS post_channels (
      id                  TEXT NOT NULL,
      platform            TEXT NOT NULL CHECK (platform IN ('telegram', 'max')),
      title               TEXT,
      username            TEXT,
      color               TEXT,
      is_active           INTEGER NOT NULL DEFAULT 1,
      subscribers_count   INTEGER NOT NULL DEFAULT 0,
      metadata_json       TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, id)
    );
    CREATE INDEX IF NOT EXISTS idx_post_channels_active
      ON post_channels(platform, is_active);

    /** Серии повторяющихся публикаций */
    CREATE TABLE IF NOT EXISTS post_series (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'paused', 'completed')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /** Запланированные и отправленные публикации */
    CREATE TABLE IF NOT EXISTS autoposts (
      id                    TEXT PRIMARY KEY,
      platform              TEXT NOT NULL DEFAULT 'telegram'
                            CHECK (platform IN ('telegram', 'max')),
      target_channel_id     TEXT NOT NULL,
      channel_title         TEXT,
      series_id             TEXT REFERENCES post_series(id) ON DELETE SET NULL,
      text                  TEXT NOT NULL DEFAULT '',
      media_json            TEXT NOT NULL DEFAULT '[]',
      inline_button_json    TEXT,
      inline_buttons_json   TEXT,
      status                TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('draft', 'active', 'sent', 'paused', 'failed')),
      schedule_type         TEXT NOT NULL CHECK (schedule_type IN ('once', 'recurring')),
      scheduled_at          TEXT NOT NULL,
      recurring_time        TEXT,
      weekdays_json         TEXT,
      daily_times_json      TEXT,
      timezone              TEXT NOT NULL DEFAULT 'Europe/Moscow',
      start_date            TEXT,
      end_date              TEXT,
      repeat_limit          INTEGER,
      on_failure            TEXT NOT NULL DEFAULT 'skip'
                            CHECK (on_failure IN ('skip', 'retry_15m', 'stop_series', 'notify')),
      conditions_json       TEXT NOT NULL DEFAULT '[]',
      last_sent_at          TEXT,
      last_error            TEXT,
      sent_count            INTEGER NOT NULL DEFAULT 0,
      platform_message_id   TEXT,
      created_at            TEXT NOT NULL,
      updated_at            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_autoposts_due
      ON autoposts(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_autoposts_platform_channel
      ON autoposts(platform, target_channel_id);
    CREATE INDEX IF NOT EXISTS idx_autoposts_series
      ON autoposts(series_id);

    /** Шаблоны текстов постов */
    CREATE TABLE IF NOT EXISTS post_templates (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      text                TEXT NOT NULL DEFAULT '',
      media_json          TEXT NOT NULL DEFAULT '[]',
      inline_buttons_json TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    /** Журнал попыток публикации */
    CREATE TABLE IF NOT EXISTS post_publish_log (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      autopost_id         TEXT NOT NULL,
      platform            TEXT NOT NULL,
      target_channel_id   TEXT NOT NULL,
      status              TEXT NOT NULL CHECK (status IN ('success', 'failed', 'skipped')),
      message             TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (autopost_id) REFERENCES autoposts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_post_publish_log_autopost
      ON post_publish_log(autopost_id, created_at DESC);
  `);
    migrateAutopostsColumns(db);
}
/** Добавляет новые колонки в существующую autoposts без пересоздания таблицы. */
function migrateAutopostsColumns(db) {
    const cols = db.prepare('PRAGMA table_info(autoposts)').all();
    const names = new Set(cols.map((c) => c.name));
    const additions = [
        ['platform', "TEXT NOT NULL DEFAULT 'telegram'"],
        ['series_id', 'TEXT'],
        ['inline_buttons_json', 'TEXT'],
        ['daily_times_json', 'TEXT'],
        ['start_date', 'TEXT'],
        ['end_date', 'TEXT'],
        ['repeat_limit', 'INTEGER'],
        ['on_failure', "TEXT NOT NULL DEFAULT 'skip'"],
        ['conditions_json', "TEXT NOT NULL DEFAULT '[]'"],
        ['platform_message_id', 'TEXT'],
    ];
    for (const [col, ddl] of additions) {
        if (!names.has(col)) {
            db.exec(`ALTER TABLE autoposts ADD COLUMN ${col} ${ddl}`);
        }
    }
}
function getPostsDbMeta(key) {
    const row = getPostsDb()
        .prepare('SELECT value FROM posts_db_meta WHERE key = ?')
        .get(key);
    return row?.value ?? null;
}
function setPostsDbMeta(key, value) {
    getPostsDb()
        .prepare(`INSERT INTO posts_db_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(key, value);
}
function closePostsDb() {
    if (!postsDb) {
        return;
    }
    postsDb.close();
    postsDb = null;
}
//# sourceMappingURL=postsDatabase.js.map