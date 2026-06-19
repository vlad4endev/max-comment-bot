import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

const DATA_DIR = path.resolve(__dirname, '../../data')
export const ANTISPAM_DB_PATH = path.join(DATA_DIR, 'antispam.db')

let antispamDb: Database.Database | null = null

export type AntispamSource = 'max' | 'telegram' | 'vk'

export function getAntispamDb(): Database.Database {
  if (antispamDb) {
    return antispamDb
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const instance = new Database(ANTISPAM_DB_PATH)
  instance.pragma('journal_mode = WAL')
  instance.pragma('synchronous = NORMAL')
  instance.pragma('foreign_keys = ON')
  initAntispamSchema(instance)
  antispamDb = instance
  return instance
}

function initAntispamSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS antispam_db_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS antispam_engine (
      id                      INTEGER PRIMARY KEY CHECK (id = 1),
      soft_mode               INTEGER NOT NULL DEFAULT 0,
      enabled                 INTEGER NOT NULL DEFAULT 1,
      spam_threshold          INTEGER NOT NULL DEFAULT 20,
      ban_threshold           INTEGER NOT NULL DEFAULT 100,
      captcha_required_score  INTEGER NOT NULL DEFAULT 15,
      emoji_overuse_limit     INTEGER NOT NULL DEFAULT 20,
      whitelist_user_ids_json TEXT NOT NULL DEFAULT '[]',
      blacklist_user_ids_json TEXT NOT NULL DEFAULT '[]',
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO antispam_engine (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS antispam_rules (
      id                INTEGER PRIMARY KEY CHECK (id = 1),
      block_links       INTEGER NOT NULL DEFAULT 1,
      flood_protection  INTEGER NOT NULL DEFAULT 1,
      caps_protection   INTEGER NOT NULL DEFAULT 0,
      emoji_spam        INTEGER NOT NULL DEFAULT 0,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO antispam_rules (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS antispam_stopwords (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      scope           TEXT NOT NULL CHECK (scope IN ('global', 'channel')),
      channel_chat_id INTEGER,
      word            TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (scope, channel_chat_id, word)
    );
    CREATE INDEX IF NOT EXISTS idx_antispam_stopwords_channel
      ON antispam_stopwords(channel_chat_id) WHERE scope = 'channel';

    CREATE TABLE IF NOT EXISTS antispam_channel_settings (
      channel_chat_id   INTEGER PRIMARY KEY,
      platform          TEXT NOT NULL DEFAULT 'max'
                        CHECK (platform IN ('max', 'telegram', 'vk')),
      channel_title     TEXT,
      block_links       INTEGER,
      flood_protection  INTEGER,
      auto_mute         INTEGER NOT NULL DEFAULT 0,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS antispam_restricted_users (
      user_id         INTEGER PRIMARY KEY,
      reason          TEXT,
      restricted_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS antispam_log (
      id                TEXT PRIMARY KEY,
      user_id           INTEGER NOT NULL,
      username          TEXT,
      channel_chat_id   INTEGER NOT NULL,
      channel_title     TEXT,
      reason            TEXT NOT NULL,
      text              TEXT NOT NULL,
      spam_score        INTEGER,
      action            TEXT,
      source            TEXT CHECK (source IN ('max', 'telegram', 'vk')),
      categories_json   TEXT,
      created_at        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_antispam_log_created
      ON antispam_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_antispam_log_channel
      ON antispam_log(channel_chat_id);
    CREATE INDEX IF NOT EXISTS idx_antispam_log_user
      ON antispam_log(user_id);

    CREATE TABLE IF NOT EXISTS antispam_scored_words (
      word   TEXT NOT NULL PRIMARY KEY,
      score  INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_antispam_scored_words_score
      ON antispam_scored_words(score);
  `)
}

export function getAntispamDbMeta(key: string): string | null {
  const row = getAntispamDb()
    .prepare('SELECT value FROM antispam_db_meta WHERE key = ?')
    .get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setAntispamDbMeta(key: string, value: string): void {
  getAntispamDb()
    .prepare(
      `INSERT INTO antispam_db_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value)
}

export function closeAntispamDb(): void {
  if (!antispamDb) {
    return
  }
  antispamDb.close()
  antispamDb = null
}
