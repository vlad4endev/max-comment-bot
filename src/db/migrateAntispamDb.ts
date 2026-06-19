import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { logger } from '../utils/logger'
import type { AntispamEngineConfig, AntispamLogEntry, AntispamRules, ChannelAdminExtras } from '../api/adminPanelState'
import { getAntispamDb, getAntispamDbMeta, setAntispamDbMeta } from './antispamDatabase'
import { reloadAntispamStore } from '../services/antispamStore'

const STATE_PATH = join(process.cwd(), 'data', 'admin-panel-state.json')

interface LegacyAntispamState {
  global_stopwords?: string[]
  antispam_rules?: AntispamRules
  antispam_engine?: AntispamEngineConfig
  antispam_restricted_users?: number[]
  antispam_log?: AntispamLogEntry[]
  channel_extras?: Record<string, ChannelAdminExtras>
}

function intFromBool(v: boolean): number {
  return v ? 1 : 0
}

/**
 * Однократный перенос антиспама из admin-panel-state.json в antispam.db.
 */
export async function migrateAntispamFromJson(): Promise<void> {
  if (getAntispamDbMeta('migrated_from_json') === '1') {
    ensureAntispamStore()
    return
  }

  getAntispamDb()
  const existingLog = (
    getAntispamDb().prepare('SELECT COUNT(*) AS n FROM antispam_log').get() as { n: number }
  ).n
  if (existingLog > 0) {
    setAntispamDbMeta('migrated_from_json', '1')
    ensureAntispamStore()
    return
  }

  let parsed: LegacyAntispamState = {}
  try {
    const raw = await readFile(STATE_PATH, 'utf8')
    parsed = JSON.parse(raw) as LegacyAntispamState
  } catch {
    setAntispamDbMeta('migrated_from_json', '1')
    ensureAntispamStore()
    return
  }

  const db = getAntispamDb()
  const engine = parsed.antispam_engine
  const rules = parsed.antispam_rules

  const tx = db.transaction(() => {
    if (engine) {
      db.prepare(
        `UPDATE antispam_engine SET
          soft_mode = ?, enabled = ?, spam_threshold = ?, ban_threshold = ?,
          captcha_required_score = ?, emoji_overuse_limit = ?,
          whitelist_user_ids_json = ?, blacklist_user_ids_json = ?, updated_at = datetime('now')
         WHERE id = 1`,
      ).run(
        intFromBool(engine.soft_mode ?? false),
        intFromBool(engine.enabled ?? true),
        engine.spam_threshold ?? 20,
        engine.ban_threshold ?? 100,
        engine.captcha_required_score ?? 15,
        engine.emoji_overuse_limit ?? 20,
        JSON.stringify(engine.whitelist_user_ids ?? []),
        JSON.stringify(engine.blacklist_user_ids ?? []),
      )
    }

    if (rules) {
      db.prepare(
        `UPDATE antispam_rules SET
          block_links = ?, flood_protection = ?, caps_protection = ?, emoji_spam = ?,
          updated_at = datetime('now')
         WHERE id = 1`,
      ).run(
        intFromBool(rules.block_links ?? true),
        intFromBool(rules.flood_protection ?? true),
        intFromBool(rules.caps_protection ?? false),
        intFromBool(rules.emoji_spam ?? false),
      )
    }

    if (Array.isArray(parsed.global_stopwords)) {
      db.prepare("DELETE FROM antispam_stopwords WHERE scope = 'global'").run()
      const insertWord = db.prepare(
        "INSERT OR IGNORE INTO antispam_stopwords (scope, channel_chat_id, word) VALUES ('global', NULL, ?)",
      )
      for (const word of parsed.global_stopwords) {
        const w = String(word).trim().toLowerCase()
        if (w) insertWord.run(w)
      }
    }

    if (parsed.channel_extras && typeof parsed.channel_extras === 'object') {
      const insertChannelWord = db.prepare(
        "INSERT OR IGNORE INTO antispam_stopwords (scope, channel_chat_id, word) VALUES ('channel', ?, ?)",
      )
      const upsertSettings = db.prepare(
        `INSERT INTO antispam_channel_settings (
          channel_chat_id, block_links, flood_protection, auto_mute, updated_at
        ) VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(channel_chat_id) DO UPDATE SET
          block_links = excluded.block_links,
          flood_protection = excluded.flood_protection,
          auto_mute = excluded.auto_mute,
          updated_at = excluded.updated_at`,
      )
      for (const [key, extras] of Object.entries(parsed.channel_extras)) {
        const chatId = Number.parseInt(key, 10)
        if (!Number.isInteger(chatId)) continue
        db.prepare('DELETE FROM antispam_stopwords WHERE scope = ? AND channel_chat_id = ?').run(
          'channel',
          chatId,
        )
        for (const word of extras.stopwords ?? []) {
          const w = String(word).trim().toLowerCase()
          if (w) insertChannelWord.run(chatId, w)
        }
        upsertSettings.run(
          chatId,
          extras.block_links === undefined ? null : intFromBool(extras.block_links),
          extras.flood_protection === undefined ? null : intFromBool(extras.flood_protection),
          intFromBool(extras.auto_mute ?? false),
        )
      }
    }

    if (Array.isArray(parsed.antispam_restricted_users)) {
      const insertRestricted = db.prepare(
        `INSERT OR IGNORE INTO antispam_restricted_users (user_id, reason, restricted_at)
         VALUES (?, 'migrated', datetime('now'))`,
      )
      for (const userId of parsed.antispam_restricted_users) {
        if (typeof userId === 'number' && userId > 0) insertRestricted.run(userId)
      }
    }

    if (Array.isArray(parsed.antispam_log)) {
      const insertLog = db.prepare(
        `INSERT OR IGNORE INTO antispam_log (
          id, user_id, username, channel_chat_id, channel_title, reason, text,
          spam_score, action, source, categories_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const entry of parsed.antispam_log.slice(0, 500)) {
        insertLog.run(
          entry.id,
          entry.user_id,
          entry.username,
          entry.channel_chat_id,
          entry.channel_title,
          entry.reason,
          entry.text,
          entry.spam_score ?? null,
          entry.action ?? null,
          entry.source ?? null,
          entry.categories ? JSON.stringify(entry.categories) : null,
          entry.created_at,
        )
      }
    }
  })
  tx()

  setAntispamDbMeta('migrated_from_json', '1')
  ensureAntispamStore()
  logger.info('migrateAntispamFromJson: antispam data moved to antispam.db')
}

function ensureAntispamStore(): void {
  reloadAntispamStore()
}
