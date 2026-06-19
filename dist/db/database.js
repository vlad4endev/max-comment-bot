"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDb = getDb;
exports.closeDb = closeDb;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
// Lazy import to avoid circular dependency at module load time
function getLogger() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../utils/logger').logger;
}
const DATA_DIR = node_path_1.default.resolve(__dirname, '../../data');
const DB_PATH = node_path_1.default.join(DATA_DIR, 'bot.db');
let db = null;
function getDb() {
    if (db) {
        return db;
    }
    node_fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
    const instance = new better_sqlite3_1.default(DB_PATH);
    instance.pragma('journal_mode = WAL');
    instance.pragma('synchronous = NORMAL');
    instance.pragma('foreign_keys = ON');
    initSchema(instance);
    db = instance;
    return instance;
}
function initSchema(targetDb) {
    targetDb.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      chat_id     INTEGER PRIMARY KEY,
      title       TEXT,
      type        TEXT NOT NULL,
      date_added  TEXT NOT NULL,
      active      INTEGER NOT NULL DEFAULT 1,
      settings    TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_channels_type ON channels(type);
    CREATE INDEX IF NOT EXISTS idx_channels_active ON channels(active);

    CREATE TABLE IF NOT EXISTS posts (
      post_id                  TEXT PRIMARY KEY,
      chat_id                  INTEGER NOT NULL,
      message_mid              TEXT NOT NULL,
      comments_ui_message_mid  TEXT,
      sender_name              TEXT,
      text                     TEXT NOT NULL,
      photo_url                TEXT,
      media_attachments        TEXT,
      comment_count            INTEGER NOT NULL,
      timestamp                TEXT NOT NULL,
      data                     TEXT NOT NULL,
      created_at               TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (chat_id) REFERENCES channels(chat_id)
    );
    CREATE INDEX IF NOT EXISTS idx_posts_chat_id ON posts(chat_id);
    CREATE INDEX IF NOT EXISTS idx_posts_message_mid ON posts(chat_id, message_mid);

    CREATE TABLE IF NOT EXISTS comments (
      comment_id         TEXT PRIMARY KEY,
      post_id            TEXT NOT NULL,
      user_id            INTEGER NOT NULL,
      username           TEXT NOT NULL,
      text               TEXT NOT NULL,
      timestamp          TEXT NOT NULL,
      reply              TEXT,
      notification_text  TEXT,
      notification_mids  TEXT,
      data               TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
    CREATE INDEX IF NOT EXISTS idx_comments_user_id ON comments(user_id);
    CREATE INDEX IF NOT EXISTS idx_comments_timestamp ON comments(timestamp DESC);

    CREATE TABLE IF NOT EXISTS subscribers (
      user_id     INTEGER PRIMARY KEY,
      data        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS forwarding_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_channel TEXT NOT NULL,
      max_channel_id TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      last_message_id INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS forwarded_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_message_id INTEGER NOT NULL,
      tg_channel TEXT NOT NULL,
      forwarded_at TEXT DEFAULT (datetime('now')),
      UNIQUE(tg_message_id, tg_channel)
    );

    CREATE TABLE IF NOT EXISTS channel_import_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tg_channel TEXT NOT NULL,
      max_channel_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scanning',
      import_source TEXT NOT NULL DEFAULT 'bot_queue',
      scan_next_offset INTEGER NOT NULL DEFAULT 0,
      scan_idle_rounds INTEGER NOT NULL DEFAULT 0,
      staged_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_channel_import_jobs_status ON channel_import_jobs(status);

    CREATE TABLE IF NOT EXISTS channel_import_staged (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      tg_message_id INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(job_id, tg_message_id),
      FOREIGN KEY (job_id) REFERENCES channel_import_jobs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_channel_import_staged_job ON channel_import_staged(job_id);

    CREATE TABLE IF NOT EXISTS channel_import_reader_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      scan_next_offset INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO channel_import_reader_state (id, scan_next_offset) VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS tg_chain_reader_offsets (
      token_key TEXT PRIMARY KEY,
      scan_next_offset INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tg_chain_forwarded (
      chain_id TEXT NOT NULL,
      tg_message_id INTEGER NOT NULL,
      max_message_mid TEXT,
      tg_media_group_id TEXT,
      album_chunk_index INTEGER,
      tg_payload TEXT,
      forwarded_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (chain_id, tg_message_id)
    );

    CREATE TABLE IF NOT EXISTS tg_bot_users (
      user_id      INTEGER PRIMARY KEY,
      username     TEXT,
      first_name   TEXT,
      last_name    TEXT,
      started      INTEGER NOT NULL DEFAULT 0,
      started_at   TEXT,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tg_bot_users_started ON tg_bot_users(started);

    CREATE TABLE IF NOT EXISTS tg_channels (
      chat_id       TEXT PRIMARY KEY,
      title         TEXT,
      username      TEXT,
      type          TEXT NOT NULL DEFAULT 'channel',
      bot_is_admin  INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_channel_notify_links (
      user_id           INTEGER NOT NULL,
      channel_chat_id   TEXT NOT NULL,
      joined_at         TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, channel_chat_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tg_notify_channel ON tg_channel_notify_links(channel_chat_id);

    CREATE TABLE IF NOT EXISTS channel_subscribers (
      channel_chat_id      INTEGER NOT NULL,
      user_id              INTEGER NOT NULL,
      name                 TEXT,
      username             TEXT,
      avatar_url           TEXT,
      is_admin             INTEGER NOT NULL DEFAULT 0,
      is_owner             INTEGER NOT NULL DEFAULT 0,
      join_time            INTEGER,
      last_activity_time   INTEGER,
      synced_at            TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel_chat_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_subscribers_user ON channel_subscribers(user_id);
    CREATE INDEX IF NOT EXISTS idx_channel_subscribers_channel ON channel_subscribers(channel_chat_id);

    CREATE TABLE IF NOT EXISTS channel_subscribers_sync (
      channel_chat_id      INTEGER PRIMARY KEY,
      last_synced_at       TEXT NOT NULL,
      members_total        INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS owner_profiles (
      id          TEXT PRIMARY KEY,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS owner_profile_accounts (
      profile_id        TEXT NOT NULL,
      platform          TEXT NOT NULL CHECK (platform IN ('max', 'telegram')),
      platform_user_id  TEXT NOT NULL,
      username          TEXT,
      first_name        TEXT,
      last_name         TEXT,
      photo_url         TEXT,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, platform_user_id),
      FOREIGN KEY (profile_id) REFERENCES owner_profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_owner_profile_accounts_profile
      ON owner_profile_accounts(profile_id);

    CREATE TABLE IF NOT EXISTS channel_link_drafts (
      code            TEXT PRIMARY KEY,
      profile_id      TEXT NOT NULL,
      max_chat_id     INTEGER NOT NULL,
      max_user_id     INTEGER NOT NULL,
      max_title       TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      tg_channel_id   TEXT,
      tg_username     TEXT,
      tg_user_id      INTEGER,
      chain_id        TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at      TEXT NOT NULL,
      FOREIGN KEY (profile_id) REFERENCES owner_profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_channel_link_drafts_max_chat
      ON channel_link_drafts(max_chat_id, status);
  `);
    migrateChannelImportSchema(targetDb);
    migratePostsSchema(targetDb);
    migratePostIdAliasesSchema(targetDb);
    migrateTgChainForwardedSchema(targetDb);
    migrateChannelLinkDraftsSchema(targetDb);
    migrateAccountPairingTokensSchema(targetDb);
    migrateChannelJoinNotifiedSchema(targetDb);
    migrateCommentSyncSchema(targetDb);
}
/** Флаг «уведомление о подключении уже отправлено» — переживает рестарт процесса. */
function migrateChannelJoinNotifiedSchema(database) {
    const tgCols = database.prepare('PRAGMA table_info(tg_channels)').all();
    if (!tgCols.some((c) => c.name === 'admin_join_notified')) {
        database.exec('ALTER TABLE tg_channels ADD COLUMN admin_join_notified INTEGER NOT NULL DEFAULT 0');
        database.exec('UPDATE tg_channels SET admin_join_notified = 1 WHERE bot_is_admin = 1');
    }
    const maxCols = database.prepare('PRAGMA table_info(channels)').all();
    if (!maxCols.some((c) => c.name === 'admin_join_notified')) {
        database.exec('ALTER TABLE channels ADD COLUMN admin_join_notified INTEGER NOT NULL DEFAULT 0');
        database.exec('UPDATE channels SET admin_join_notified = 1 WHERE active = 1');
    }
}
function migrateAccountPairingTokensSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS account_pairing_tokens (
      token             TEXT PRIMARY KEY,
      profile_id        TEXT NOT NULL,
      initiator_platform TEXT NOT NULL CHECK (initiator_platform IN ('max', 'telegram')),
      initiator_user_id TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'expired')),
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at        TEXT NOT NULL,
      completed_at      TEXT,
      FOREIGN KEY (profile_id) REFERENCES owner_profiles(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_account_pairing_tokens_profile
      ON account_pairing_tokens(profile_id, status);
  `);
}
function migrateChannelLinkDraftsSchema(database) {
    const cols = database.prepare('PRAGMA table_info(channel_link_drafts)').all();
    if (!cols.some((c) => c.name === 'forward_posts')) {
        database.exec('ALTER TABLE channel_link_drafts ADD COLUMN forward_posts INTEGER NOT NULL DEFAULT 1');
    }
    if (!cols.some((c) => c.name === 'add_comments_button')) {
        database.exec('ALTER TABLE channel_link_drafts ADD COLUMN add_comments_button INTEGER NOT NULL DEFAULT 1');
    }
}
function migratePostIdAliasesSchema(database) {
    database.exec(`
    CREATE TABLE IF NOT EXISTS post_id_aliases (
      alias_post_id TEXT PRIMARY KEY,
      post_id       TEXT NOT NULL,
      chat_id       INTEGER NOT NULL,
      message_mid   TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_post_id_aliases_post_id ON post_id_aliases(post_id);
  `);
}
function migrateChannelImportSchema(database) {
    const cols = database.prepare('PRAGMA table_info(channel_import_jobs)').all();
    if (!cols.some((c) => c.name === 'import_source')) {
        database.exec("ALTER TABLE channel_import_jobs ADD COLUMN import_source TEXT NOT NULL DEFAULT 'bot_queue'");
    }
}
/**
 * Adds a unique index on (chat_id, message_mid) to prevent duplicate post rows.
 * Deduplicates existing rows first (keeps the row with the lowest rowid for each pair).
 */
function migratePostsSchema(database) {
    const log = getLogger();
    const indexes = database.prepare("PRAGMA index_list(posts)").all();
    const hasUnique = indexes.some((i) => i.name === 'idx_posts_unique_chat_mid');
    if (hasUnique) {
        return;
    }
    log.info('db.migrate: добавляем UNIQUE(chat_id, message_mid) — дедупликация постов');
    // Deduplicate: keep lowest rowid per (chat_id, message_mid)
    const before = database.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
    database.exec(`
    DELETE FROM posts
    WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM posts GROUP BY chat_id, message_mid
    )
  `);
    const after = database.prepare('SELECT COUNT(*) AS n FROM posts').get().n;
    if (before !== after) {
        log.warn('db.migrate: удалены дубли постов', { removed: before - after, remaining: after });
    }
    database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_unique_chat_mid ON posts(chat_id, message_mid)');
    log.info('db.migrate: UNIQUE индекс создан', { posts: after });
}
function migrateTgChainForwardedSchema(database) {
    const cols = database.prepare('PRAGMA table_info(tg_chain_forwarded)').all();
    const hasMaxMid = cols.some((c) => c.name === 'max_message_mid');
    const hasMediaGroup = cols.some((c) => c.name === 'tg_media_group_id');
    const hasChunk = cols.some((c) => c.name === 'album_chunk_index');
    const hasPayload = cols.some((c) => c.name === 'tg_payload');
    if (!hasMaxMid) {
        database.exec('ALTER TABLE tg_chain_forwarded ADD COLUMN max_message_mid TEXT');
    }
    if (!hasMediaGroup) {
        database.exec('ALTER TABLE tg_chain_forwarded ADD COLUMN tg_media_group_id TEXT');
    }
    if (!hasChunk) {
        database.exec('ALTER TABLE tg_chain_forwarded ADD COLUMN album_chunk_index INTEGER');
    }
    if (!hasPayload) {
        database.exec('ALTER TABLE tg_chain_forwarded ADD COLUMN tg_payload TEXT');
    }
}
function migrateCommentSyncSchema(database) {
    // Таблица маппинга: связывает tg_message_id с max_message_mid
    // Дополняет tg_chain_forwarded — не заменяет её
    database.prepare(`
    CREATE TABLE IF NOT EXISTS post_comment_mapping (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id     TEXT    NOT NULL,
      tg_msg_id    INTEGER NOT NULL,
      max_mid      TEXT    NOT NULL,
      tg_chat_id   INTEGER,
      created_at   TEXT    DEFAULT (datetime('now')),
      UNIQUE (chain_id, tg_msg_id)
    )
  `).run();
    // Таблица синхронизированных комментариев
    // Если таблица comments уже есть — добавляем только недостающие колонки
    const commentCols = database.prepare('PRAGMA table_info(comments)').all();
    const colNames = commentCols.map((c) => c.name);
    if (!colNames.includes('tg_comment_id')) {
        database.prepare('ALTER TABLE comments ADD COLUMN tg_comment_id INTEGER').run();
    }
    if (!colNames.includes('max_comment_id')) {
        database.prepare('ALTER TABLE comments ADD COLUMN max_comment_id TEXT').run();
    }
    if (!colNames.includes('source')) {
        database.prepare("ALTER TABLE comments ADD COLUMN source TEXT DEFAULT 'max'").run();
    }
    if (!colNames.includes('synced')) {
        database.prepare('ALTER TABLE comments ADD COLUMN synced INTEGER DEFAULT 0').run();
    }
    if (!colNames.includes('tg_thread_reply_id')) {
        database.prepare('ALTER TABLE comments ADD COLUMN tg_thread_reply_id INTEGER').run();
    }
    const mappingCols = database.prepare('PRAGMA table_info(post_comment_mapping)').all();
    const mappingColNames = mappingCols.map((c) => c.name);
    if (!mappingColNames.includes('tg_thread_chat_id')) {
        database.prepare('ALTER TABLE post_comment_mapping ADD COLUMN tg_thread_chat_id INTEGER').run();
    }
    if (!mappingColNames.includes('tg_thread_msg_id')) {
        database.prepare('ALTER TABLE post_comment_mapping ADD COLUMN tg_thread_msg_id INTEGER').run();
    }
    // Индексы для быстрого поиска
    database.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_tg_comment_id
     ON comments (tg_comment_id) WHERE tg_comment_id IS NOT NULL`).run();
    database.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_max_comment_id
     ON comments (max_comment_id) WHERE max_comment_id IS NOT NULL`).run();
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_post_comment_mapping_tg
     ON post_comment_mapping (chain_id, tg_msg_id)`).run();
    database.prepare(`CREATE INDEX IF NOT EXISTS idx_post_comment_mapping_thread
     ON post_comment_mapping (chain_id, tg_thread_msg_id)`).run();
    backfillPostCommentMappingsFromForwarded(database);
}
function backfillPostCommentMappingsFromForwarded(database) {
    const rows = database
        .prepare(`SELECT chain_id, tg_message_id, max_message_mid, tg_payload
       FROM tg_chain_forwarded
       WHERE max_message_mid IS NOT NULL AND TRIM(max_message_mid) != ''`)
        .all();
    const insert = database.prepare(`INSERT INTO post_comment_mapping (chain_id, tg_msg_id, max_mid, tg_chat_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chain_id, tg_msg_id) DO NOTHING`);
    let inserted = 0;
    for (const row of rows) {
        let tgChatId = null;
        if (row.tg_payload) {
            try {
                const parsed = JSON.parse(row.tg_payload);
                if (typeof parsed.chat?.id === 'number') {
                    tgChatId = parsed.chat.id;
                }
            }
            catch {
                // ignore corrupt payload
            }
        }
        const result = insert.run(row.chain_id, row.tg_message_id, row.max_message_mid.trim(), tgChatId);
        inserted += Number(result.changes) || 0;
    }
    if (inserted > 0) {
        getLogger().info('migrateCommentSyncSchema: backfilled post_comment_mapping', { inserted });
    }
}
function closeDb() {
    if (!db) {
        return;
    }
    db.close();
    db = null;
}
//# sourceMappingURL=database.js.map