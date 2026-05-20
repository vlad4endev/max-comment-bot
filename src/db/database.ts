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
      forwarded_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (chain_id, tg_message_id)
    );
  `)
  migrateChannelImportSchema(targetDb)
  migratePostsSchema(targetDb)
  migratePostIdSequence(targetDb)
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

/**
 * Monotonic numeric post ids (Telegram-style message_id), separate from MAX `message_mid`.
 */
function migratePostIdSequence(database: Database.Database): void {
  const log = getLogger()
  database.exec(`
    CREATE TABLE IF NOT EXISTS post_id_sequence (
      id      INTEGER PRIMARY KEY CHECK (id = 1),
      next_id INTEGER NOT NULL DEFAULT 1
    );
    INSERT OR IGNORE INTO post_id_sequence (id, next_id) VALUES (1, 1);
  `)
  const row = database.prepare('SELECT next_id FROM post_id_sequence WHERE id = 1').get() as
    | { next_id: number }
    | undefined
  if (!row || row.next_id < 1) {
    database.prepare('UPDATE post_id_sequence SET next_id = 1 WHERE id = 1').run()
  }
  const maxNumeric = (
    database
      .prepare(
        `SELECT MAX(CAST(post_id AS INTEGER)) AS m FROM posts
         WHERE post_id GLOB '[0-9]*' AND CAST(post_id AS INTEGER) > 0`,
      )
      .get() as { m: number | null }
  ).m
  if (maxNumeric !== null && Number.isFinite(maxNumeric) && maxNumeric >= 1) {
    const bumped = Math.max(row?.next_id ?? 1, maxNumeric + 1)
    if (bumped > (row?.next_id ?? 1)) {
      database.prepare('UPDATE post_id_sequence SET next_id = ? WHERE id = 1').run(bumped)
      log.info('db.migrate: post_id_sequence synced from posts', { next_id: bumped })
    }
  }
}

export function closeDb(): void {
  if (!db) {
    return
  }
  db.close()
  db = null
}
