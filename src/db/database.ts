import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

const DATA_DIR = path.resolve(__dirname, '../../data')
const DB_PATH = path.join(DATA_DIR, 'bot.db')

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) {
    return db
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
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
  `)
}

export function closeDb(): void {
  if (!db) {
    return
  }
  db.close()
  db = null
}
