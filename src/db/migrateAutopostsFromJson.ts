import fs from 'node:fs'
import path from 'node:path'

import { logger } from '../utils/logger'
import { createAutopost, listAutoposts, updateAutopost } from '../services/autopostStore'
import { getPostsDb } from './postsDatabase'

const ADMIN_STATE_PATH = path.join(process.cwd(), 'data', 'admin-panel-state.json')

interface LegacyAutopost {
  id: string
  chat_id: number
  channel_title: string | null
  text: string
  scheduled_at: string
  repeat: 'none' | 'daily' | 'weekly' | 'monthly'
  status: string
  created_at: string
}

/**
 * Однократный перенос автопостов из admin-panel-state.json в SQLite.
 * Старые записи (MAX chat_id) сохраняются как target_channel_id; для TG нужно пересоздать в админке.
 */
export function migrateAutopostsFromJson(): void {
  getPostsDb()
  if (listAutoposts().length > 0) {
    return
  }
  if (!fs.existsSync(ADMIN_STATE_PATH)) {
    return
  }
  try {
    const raw = fs.readFileSync(ADMIN_STATE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as { autoposts?: LegacyAutopost[] }
    const legacy = Array.isArray(parsed.autoposts) ? parsed.autoposts : []
    if (legacy.length === 0) {
      return
    }
    let imported = 0
    for (const row of legacy) {
      if (!row.text?.trim() || !row.scheduled_at) {
        continue
      }
      const scheduleType = row.repeat === 'none' ? 'once' : 'recurring'
      let recurringTime: string | null = null
      let weekdays: number[] | null = null
      if (scheduleType === 'recurring') {
        const d = new Date(row.scheduled_at)
        recurringTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        weekdays =
          row.repeat === 'weekly'
            ? [d.getDay()]
            : [0, 1, 2, 3, 4, 5, 6]
      }
      const status =
        row.status === 'sent' ? 'sent' : row.status === 'failed' ? 'failed' : 'active'
      const created = createAutopost({
        text: row.text,
        target_channel_id: String(row.chat_id),
        channel_title: row.channel_title,
        schedule_type: scheduleType,
        scheduled_at: row.scheduled_at,
        recurring_time: recurringTime,
        weekdays,
      })
      imported += 1
      if (status !== 'active') {
        updateAutopost(created.id, { status: status as 'sent' | 'failed' })
      }
    }
    if (imported > 0) {
      logger.info('migrateAutopostsFromJson: imported legacy autoposts', { count: imported })
    }
  } catch (err: unknown) {
    logger.warn('migrateAutopostsFromJson failed', err)
  }
}
