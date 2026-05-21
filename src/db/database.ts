import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

// Lazy import to avoid circular dependency at module load time
function getLogger() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('../utils/logger') as { logger: { info: (m: string, d?: unknown) => void; warn: (m: string, d?: unknown) => void; error: (m: string, d?: unknown) => void } }).logger
}

const DATA_DIR = path.resolve(__dirname, '../../data')
const DB_PATH = path.join(DATA_DIR, 'bot.db')

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) {
    return db
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const instance = new Database(DB_PATH)
  instance.pragma('journal_mode = WAL')
  instance.pragma('synchronous = NORMAL')
  instance.pragma('foreign_keys = ON')
  initSchema(instance)
  db = instance
  return instance
}

function initSchema(targetDb: Database.Database): void {
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

    CREATE TABLE IF NOT EXISTS autoposts (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL DEFAULT '',
      media_json TEXT NOT NULL DEFAULT '[]',
      inline_button_json TEXT,
      target_channel_id TEXT NOT NULL,
      channel_title TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      schedule_type TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      recurring_time TEXT,
      weekdays_json TEXT,
      timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
      last_sent_at TEXT,
      last_error TEXT,
      sent_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_autoposts_due
      ON autoposts(status, scheduled_at);

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
  `)
  migrateChannelImportSchema(targetDb)
  migratePostsSchema(targetDb)
  migratePostIdAliasesSchema(targetDb)
  migrateTgChainForwardedSchema(targetDb)
}

function migratePostIdAliasesSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS post_id_aliases (
      alias_post_id TEXT PRIMARY KEY,
      post_id       TEXT NOT NULL,
      chat_id       INTEGER NOT NULL,
      message_mid   TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_post_id_aliases_post_id ON post_id_aliases(post_id);
  `)
}

function migrateChannelImportSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(channel_import_jobs)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'import_source')) {
    database.exec(
      "ALTER TABLE channel_import_jobs ADD COLUMN import_source TEXT NOT NULL DEFAULT 'bot_queue'",
    )
  }
}

/**
 * Adds a unique index on (chat_id, message_mid) to prevent duplicate post rows.
 * Deduplicates existing rows first (keeps the row with the lowest rowid for each pair).
 */
function migratePostsSchema(database: Database.Database): void {
  const log = getLogger()
  const indexes = database.prepare("PRAGMA index_list(posts)").all() as { name: string }[]
  const hasUnique = indexes.some((i) => i.name === 'idx_posts_unique_chat_mid')
  if (hasUnique) {
    return
  }
  log.info('db.migrate: добавляем UNIQUE(chat_id, message_mid) — дедупликация постов')
  // Deduplicate: keep lowest rowid per (chat_id, message_mid)
  const before = (database.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n
  database.exec(`
    DELETE FROM posts
    WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM posts GROUP BY chat_id, message_mid
    )
  `)
  const after = (database.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n
  if (before !== after) {
    log.warn('db.migrate: удалены дубли постов', { removed: before - after, remaining: after })
  }
  database.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_unique_chat_mid ON posts(chat_id, message_mid)',
  )
  log.info('db.migrate: UNIQUE индекс создан', { posts: after })
}

function migrateTgChainForwardedSchema(database: Database.Database): void {
  const cols = database.prepare('PRAGMA table_info(tg_chain_forwarded)').all() as { name: string }[]
  const hasMaxMid = cols.some((c) => c.name === 'max_message_mid')
  const hasMediaGroup = cols.some((c) => c.name === 'tg_media_group_id')
  const hasChunk = cols.some((c) => c.name === 'album_chunk_index')
  const hasPayload = cols.some((c) => c.name === 'tg_payload')
  if (!hasMaxMid) {
    database.exec('ALTER TABLE tg_chain_forwarded ADD COLUMN max_message_mid TEXT')
  }
  if (!hasMediaGroup) {
    database.exec('ALTER TABLE tg_chain_forwarded ADD COLUMN tg_media_group_id TEXT')
  }
  if (!hasChunk) {
    database.exec('ALTER TABLE tg_chain_forwarded ADD COLUMN album_chunk_index INTEGER')
  }
  if (!hasPayload) {
    database.exec('ALTER TABLE tg_chain_forwarded ADD COLUMN tg_payload TEXT')
  }
}

export function closeDb(): void {
  if (!db) {
    return
  }
  db.close()
  db = null
}
