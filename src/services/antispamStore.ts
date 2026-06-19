import { randomUUID } from 'node:crypto'

import { getAntispamDb } from '../db/antispamDatabase'
import type { ScoredWordsByScore } from '../db/seedAntispamScoredWords'
import { loadScoredWordsFromDb, persistScoredWords } from '../db/seedAntispamScoredWords'
import type {
  AntispamEngineConfig,
  AntispamLogEntry,
  AntispamRules,
} from '../api/adminPanelState'

export interface ChannelAntispamSettings {
  stopwords: string[]
  block_links: boolean | null
  flood_protection: boolean | null
  auto_mute: boolean
}

const DEFAULT_ENGINE: AntispamEngineConfig = {
  soft_mode: false,
  enabled: true,
  spam_threshold: 20,
  ban_threshold: 100,
  captcha_required_score: 15,
  emoji_overuse_limit: 20,
  whitelist_user_ids: [685859062],
  blacklist_user_ids: [],
}

const DEFAULT_RULES: AntispamRules = {
  block_links: true,
  flood_protection: true,
  caps_protection: false,
  emoji_spam: false,
}

interface AntispamCache {
  engine: AntispamEngineConfig
  rules: AntispamRules
  globalStopwords: string[]
  scoredWordsByScore: ScoredWordsByScore
  channelStopwords: Map<number, string[]>
  channelSettings: Map<number, Omit<ChannelAntispamSettings, 'stopwords'>>
  restrictedUsers: Set<number>
}

let cache: AntispamCache | null = null

function intFromBool(v: boolean): number {
  return v ? 1 : 0
}

function parseIdList(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is number => typeof id === 'number' && id > 0)
  } catch {
    return []
  }
}

function loadEngineFromDb(): AntispamEngineConfig {
  const row = getAntispamDb()
    .prepare('SELECT * FROM antispam_engine WHERE id = 1')
    .get() as {
    soft_mode: number
    enabled: number
    spam_threshold: number
    ban_threshold: number
    captcha_required_score: number
    emoji_overuse_limit: number
    whitelist_user_ids_json: string
    blacklist_user_ids_json: string
  }
  return {
    soft_mode: row.soft_mode === 1,
    enabled: row.enabled === 1,
    spam_threshold: row.spam_threshold,
    ban_threshold: row.ban_threshold,
    captcha_required_score: row.captcha_required_score,
    emoji_overuse_limit: row.emoji_overuse_limit,
    whitelist_user_ids: parseIdList(row.whitelist_user_ids_json),
    blacklist_user_ids: parseIdList(row.blacklist_user_ids_json),
  }
}

function loadRulesFromDb(): AntispamRules {
  const row = getAntispamDb()
    .prepare('SELECT * FROM antispam_rules WHERE id = 1')
    .get() as {
    block_links: number
    flood_protection: number
    caps_protection: number
    emoji_spam: number
  }
  return {
    block_links: row.block_links === 1,
    flood_protection: row.flood_protection === 1,
    caps_protection: row.caps_protection === 1,
    emoji_spam: row.emoji_spam === 1,
  }
}

function loadCacheFromDb(): AntispamCache {
  const globalRows = getAntispamDb()
    .prepare("SELECT word FROM antispam_stopwords WHERE scope = 'global' ORDER BY word ASC")
    .all() as { word: string }[]

  const channelWordRows = getAntispamDb()
    .prepare(
      "SELECT channel_chat_id, word FROM antispam_stopwords WHERE scope = 'channel' ORDER BY channel_chat_id, word ASC",
    )
    .all() as { channel_chat_id: number; word: string }[]

  const channelStopwords = new Map<number, string[]>()
  for (const row of channelWordRows) {
    const list = channelStopwords.get(row.channel_chat_id) ?? []
    list.push(row.word)
    channelStopwords.set(row.channel_chat_id, list)
  }

  const channelSettings = new Map<number, Omit<ChannelAntispamSettings, 'stopwords'>>()
  const settingsRows = getAntispamDb()
    .prepare('SELECT * FROM antispam_channel_settings')
    .all() as Array<{
    channel_chat_id: number
    block_links: number | null
    flood_protection: number | null
    auto_mute: number
  }>
  for (const row of settingsRows) {
    channelSettings.set(row.channel_chat_id, {
      block_links: row.block_links === null ? null : row.block_links === 1,
      flood_protection: row.flood_protection === null ? null : row.flood_protection === 1,
      auto_mute: row.auto_mute === 1,
    })
  }

  const restrictedRows = getAntispamDb()
    .prepare('SELECT user_id FROM antispam_restricted_users')
    .all() as { user_id: number }[]

  return {
    engine: loadEngineFromDb(),
    rules: loadRulesFromDb(),
    globalStopwords: globalRows.map((r) => r.word),
    scoredWordsByScore: loadScoredWordsFromDb(),
    channelStopwords,
    channelSettings,
    restrictedUsers: new Set(restrictedRows.map((r) => r.user_id)),
  }
}

export function ensureAntispamStoreLoaded(): void {
  if (!cache) {
    getAntispamDb()
    cache = loadCacheFromDb()
  }
}

export function reloadAntispamStore(): void {
  getAntispamDb()
  cache = loadCacheFromDb()
}

export function getAntispamEngineSync(): AntispamEngineConfig {
  ensureAntispamStoreLoaded()
  return { ...cache!.engine }
}

export function getAntispamRulesSync(): AntispamRules {
  ensureAntispamStoreLoaded()
  return { ...cache!.rules }
}

export function getGlobalStopwordsSync(): string[] {
  ensureAntispamStoreLoaded()
  return [...cache!.globalStopwords]
}

export function getScoredWordsSync(): ScoredWordsByScore {
  ensureAntispamStoreLoaded()
  const src = cache!.scoredWordsByScore
  const out: ScoredWordsByScore = {}
  for (const [score, words] of Object.entries(src)) {
    out[Number(score)] = [...words]
  }
  return out
}

export function countScoredWordsSync(): number {
  ensureAntispamStoreLoaded()
  let n = 0
  for (const words of Object.values(cache!.scoredWordsByScore)) {
    n += words.length
  }
  return n
}

export function saveScoredWordsToStore(dict: ScoredWordsByScore): ScoredWordsByScore {
  ensureAntispamStoreLoaded()
  persistScoredWords(dict)
  cache!.scoredWordsByScore = loadScoredWordsFromDb()
  return getScoredWordsSync()
}

export function getChannelAntispamSettingsSync(chatId: number): ChannelAntispamSettings {
  ensureAntispamStoreLoaded()
  const settings = cache!.channelSettings.get(chatId)
  return {
    stopwords: [...(cache!.channelStopwords.get(chatId) ?? [])],
    block_links: settings?.block_links ?? null,
    flood_protection: settings?.flood_protection ?? null,
    auto_mute: settings?.auto_mute ?? false,
  }
}

export function isAntispamRestrictedUserSync(userId: number): boolean {
  ensureAntispamStoreLoaded()
  if (!Number.isInteger(userId) || userId <= 0) return false
  return cache!.restrictedUsers.has(userId)
}

export function getAntispamWordsSnapshot(): {
  global: string[]
  byChannel: Record<string, string[]>
  rules: AntispamRules
  engine: AntispamEngineConfig
  restricted_users: number[]
  scored_words: ScoredWordsByScore
  scored_words_total: number
} {
  ensureAntispamStoreLoaded()
  const byChannel: Record<string, string[]> = {}
  for (const [chatId, words] of cache!.channelStopwords.entries()) {
    byChannel[String(chatId)] = [...words]
  }
  return {
    global: [...cache!.globalStopwords],
    byChannel,
    rules: { ...cache!.rules },
    engine: { ...cache!.engine },
    restricted_users: [...cache!.restrictedUsers],
    scored_words: getScoredWordsSync(),
    scored_words_total: countScoredWordsSync(),
  }
}

export function saveAntispamEngineToStore(patch: Partial<AntispamEngineConfig>): AntispamEngineConfig {
  ensureAntispamStoreLoaded()
  const next: AntispamEngineConfig = {
    ...cache!.engine,
    ...patch,
  }
  if (patch.whitelist_user_ids) {
    next.whitelist_user_ids = patch.whitelist_user_ids.filter((id) => id > 0)
  }
  if (patch.blacklist_user_ids) {
    next.blacklist_user_ids = patch.blacklist_user_ids.filter((id) => id > 0)
  }
  const now = new Date().toISOString()
  getAntispamDb()
    .prepare(
      `UPDATE antispam_engine SET
        soft_mode = ?, enabled = ?, spam_threshold = ?, ban_threshold = ?,
        captcha_required_score = ?, emoji_overuse_limit = ?,
        whitelist_user_ids_json = ?, blacklist_user_ids_json = ?, updated_at = ?
       WHERE id = 1`,
    )
    .run(
      intFromBool(next.soft_mode),
      intFromBool(next.enabled),
      next.spam_threshold,
      next.ban_threshold,
      next.captcha_required_score,
      next.emoji_overuse_limit,
      JSON.stringify(next.whitelist_user_ids),
      JSON.stringify(next.blacklist_user_ids),
      now,
    )
  cache!.engine = next
  return { ...next }
}

export function saveAntispamWordsToStore(input: {
  global?: string[]
  rules?: Partial<AntispamRules>
}): void {
  ensureAntispamStoreLoaded()
  const db = getAntispamDb()
  if (input.global) {
    const words = [...new Set(input.global.map((w) => w.trim().toLowerCase()).filter(Boolean))]
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM antispam_stopwords WHERE scope = 'global'").run()
      const insert = db.prepare(
        "INSERT INTO antispam_stopwords (scope, channel_chat_id, word) VALUES ('global', NULL, ?)",
      )
      for (const word of words) {
        insert.run(word)
      }
    })
    tx()
    cache!.globalStopwords = words
  }
  if (input.rules) {
    const next = { ...cache!.rules, ...input.rules }
    getAntispamDb()
      .prepare(
        `UPDATE antispam_rules SET
          block_links = ?, flood_protection = ?, caps_protection = ?, emoji_spam = ?, updated_at = ?
         WHERE id = 1`,
      )
      .run(
        intFromBool(next.block_links),
        intFromBool(next.flood_protection),
        intFromBool(next.caps_protection),
        intFromBool(next.emoji_spam),
        new Date().toISOString(),
      )
    cache!.rules = next
  }
}

export function saveChannelAntispamSettings(
  chatId: number,
  patch: Partial<ChannelAntispamSettings>,
): ChannelAntispamSettings {
  ensureAntispamStoreLoaded()
  const current = getChannelAntispamSettingsSync(chatId)
  const next: ChannelAntispamSettings = {
    stopwords: patch.stopwords
      ? [...new Set(patch.stopwords.map((w) => w.trim().toLowerCase()).filter(Boolean))]
      : current.stopwords,
    block_links: patch.block_links !== undefined ? patch.block_links : current.block_links,
    flood_protection:
      patch.flood_protection !== undefined ? patch.flood_protection : current.flood_protection,
    auto_mute: patch.auto_mute !== undefined ? patch.auto_mute : current.auto_mute,
  }

  const db = getAntispamDb()
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM antispam_stopwords WHERE scope = ? AND channel_chat_id = ?').run(
      'channel',
      chatId,
    )
    const insertWord = db.prepare(
      "INSERT INTO antispam_stopwords (scope, channel_chat_id, word) VALUES ('channel', ?, ?)",
    )
    for (const word of next.stopwords) {
      insertWord.run(chatId, word)
    }
    db.prepare(
      `INSERT INTO antispam_channel_settings (
        channel_chat_id, block_links, flood_protection, auto_mute, updated_at
      ) VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(channel_chat_id) DO UPDATE SET
        block_links = excluded.block_links,
        flood_protection = excluded.flood_protection,
        auto_mute = excluded.auto_mute,
        updated_at = excluded.updated_at`,
    ).run(
      chatId,
      next.block_links === null ? null : intFromBool(next.block_links),
      next.flood_protection === null ? null : intFromBool(next.flood_protection),
      intFromBool(next.auto_mute),
    )
  })
  tx()

  cache!.channelStopwords.set(chatId, next.stopwords)
  cache!.channelSettings.set(chatId, {
    block_links: next.block_links,
    flood_protection: next.flood_protection,
    auto_mute: next.auto_mute,
  })
  return next
}

export function restrictAntispamUserInStore(userId: number): void {
  if (!Number.isInteger(userId) || userId <= 0) return
  ensureAntispamStoreLoaded()
  if (cache!.restrictedUsers.has(userId)) return
  getAntispamDb()
    .prepare(
      `INSERT INTO antispam_restricted_users (user_id, reason, restricted_at)
       VALUES (?, 'auto_mute', datetime('now'))
       ON CONFLICT(user_id) DO NOTHING`,
    )
    .run(userId)
  cache!.restrictedUsers.add(userId)
}

export function pushAntispamLogToStore(
  entry: Omit<AntispamLogEntry, 'id' | 'created_at'>,
): AntispamLogEntry {
  ensureAntispamStoreLoaded()
  const row: AntispamLogEntry = {
    ...entry,
    id: randomUUID(),
    created_at: new Date().toISOString(),
  }
  getAntispamDb()
    .prepare(
      `INSERT INTO antispam_log (
        id, user_id, username, channel_chat_id, channel_title, reason, text,
        spam_score, action, source, categories_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.user_id,
      row.username,
      row.channel_chat_id,
      row.channel_title,
      row.reason,
      row.text,
      row.spam_score ?? null,
      row.action ?? null,
      row.source ?? null,
      row.categories ? JSON.stringify(row.categories) : null,
      row.created_at,
    )
  getAntispamDb()
    .prepare(
      `DELETE FROM antispam_log WHERE id NOT IN (
        SELECT id FROM antispam_log ORDER BY created_at DESC LIMIT 500
      )`,
    )
    .run()
  return row
}

export function listAntispamLogFromStore(limit: number): AntispamLogEntry[] {
  ensureAntispamStoreLoaded()
  const n = Math.min(Math.max(1, limit), 200)
  const rows = getAntispamDb()
    .prepare('SELECT * FROM antispam_log ORDER BY created_at DESC LIMIT ?')
    .all(n) as Array<{
    id: string
    user_id: number
    username: string | null
    channel_chat_id: number
    channel_title: string | null
    reason: string
    text: string
    spam_score: number | null
    action: string | null
    source: string | null
    categories_json: string | null
    created_at: string
  }>
  return rows.map((row) => ({
    id: row.id,
    user_id: row.user_id,
    username: row.username,
    channel_chat_id: row.channel_chat_id,
    channel_title: row.channel_title,
    reason: row.reason,
    text: row.text,
    spam_score: row.spam_score ?? undefined,
    action: row.action ?? undefined,
    source: row.source ?? undefined,
    categories: row.categories_json
      ? (JSON.parse(row.categories_json) as string[])
      : undefined,
    created_at: row.created_at,
  }))
}

export function purgeAntispamChannelData(chatId: number): void {
  ensureAntispamStoreLoaded()
  const targetAbs = Math.abs(chatId)
  const db = getAntispamDb()
  db.prepare('DELETE FROM antispam_stopwords WHERE scope = ? AND ABS(channel_chat_id) = ?').run(
    'channel',
    targetAbs,
  )
  db.prepare('DELETE FROM antispam_channel_settings WHERE ABS(channel_chat_id) = ?').run(targetAbs)
  db.prepare('DELETE FROM antispam_log WHERE ABS(channel_chat_id) = ?').run(targetAbs)

  for (const key of [...cache!.channelStopwords.keys()]) {
    if (Math.abs(key) === targetAbs) cache!.channelStopwords.delete(key)
  }
  for (const key of [...cache!.channelSettings.keys()]) {
    if (Math.abs(key) === targetAbs) cache!.channelSettings.delete(key)
  }
}

export function countAntispamBlocksTodayFromStore(): number {
  const today = new Date().toISOString().slice(0, 10)
  const row = getAntispamDb()
    .prepare("SELECT COUNT(*) AS n FROM antispam_log WHERE created_at >= ?")
    .get(`${today}T00:00:00.000Z`) as { n: number }
  return row.n
}
