import { getDb } from './database'
import { getPostsDb, getPostsDbMeta, setPostsDbMeta } from './postsDatabase'
import { logger } from '../utils/logger'

interface LegacyBotAutopostRow {
  id: string
  text: string
  media_json: string
  inline_button_json: string | null
  target_channel_id: string
  channel_title: string | null
  status: string
  schedule_type: string
  scheduled_at: string
  recurring_time: string | null
  weekdays_json: string | null
  timezone: string
  last_sent_at: string | null
  last_error: string | null
  sent_count: number
  created_at: string
  updated_at: string
}

/**
 * Переносит autoposts из bot.db в posts.db (однократно).
 * После успешного переноса таблица autoposts удаляется из bot.db.
 */
export function migrateAutopostsFromBotDb(): void {
  if (getPostsDbMeta('migrated_from_bot_db') === '1') {
    return
  }

  const postsDb = getPostsDb()
  const existing = (postsDb.prepare('SELECT COUNT(*) AS n FROM autoposts').get() as { n: number }).n
  if (existing > 0) {
    setPostsDbMeta('migrated_from_bot_db', '1')
    return
  }

  const botDb = getDb()
  const table = botDb
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'autoposts'")
    .get() as { name: string } | undefined
  if (!table) {
    setPostsDbMeta('migrated_from_bot_db', '1')
    return
  }

  const rows = botDb.prepare('SELECT * FROM autoposts ORDER BY created_at ASC').all() as LegacyBotAutopostRow[]
  if (rows.length === 0) {
    botDb.exec('DROP TABLE IF EXISTS autoposts')
    botDb.exec('DROP INDEX IF EXISTS idx_autoposts_due')
    setPostsDbMeta('migrated_from_bot_db', '1')
    return
  }

  const insert = postsDb.prepare(
    `INSERT INTO autoposts (
      id, platform, target_channel_id, channel_title, text, media_json,
      inline_button_json, status, schedule_type, scheduled_at,
      recurring_time, weekdays_json, timezone, last_sent_at, last_error,
      sent_count, created_at, updated_at
    ) VALUES (
      ?, 'telegram', ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?
    )`,
  )

  const upsertChannel = postsDb.prepare(
    `INSERT INTO post_channels (id, platform, title, is_active, created_at, updated_at)
     VALUES (?, 'telegram', ?, 1, datetime('now'), datetime('now'))
     ON CONFLICT(platform, id) DO UPDATE SET
       title = COALESCE(excluded.title, post_channels.title),
       updated_at = datetime('now')`,
  )

  const tx = postsDb.transaction(() => {
    for (const row of rows) {
      const status =
        row.status === 'draft' ||
        row.status === 'active' ||
        row.status === 'sent' ||
        row.status === 'paused' ||
        row.status === 'failed'
          ? row.status
          : 'active'
      insert.run(
        row.id,
        row.target_channel_id,
        row.channel_title,
        row.text,
        row.media_json || '[]',
        row.inline_button_json,
        status,
        row.schedule_type === 'recurring' ? 'recurring' : 'once',
        row.scheduled_at,
        row.recurring_time,
        row.weekdays_json,
        row.timezone || 'Europe/Moscow',
        row.last_sent_at,
        row.last_error,
        row.sent_count,
        row.created_at,
        row.updated_at,
      )
      upsertChannel.run(row.target_channel_id, row.channel_title)
    }
  })
  tx()

  botDb.exec('DROP TABLE IF EXISTS autoposts')
  botDb.exec('DROP INDEX IF EXISTS idx_autoposts_due')

  setPostsDbMeta('migrated_from_bot_db', '1')
  logger.info('migratePostsDb: перенесены автопосты из bot.db в posts.db', { count: rows.length })
}
