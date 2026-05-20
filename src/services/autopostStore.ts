import { randomUUID } from 'node:crypto'

import { getDb } from '../db/database'

export type AutopostStatus = 'active' | 'sent' | 'paused' | 'failed'
export type AutopostScheduleType = 'once' | 'recurring'
export type AutopostMediaType = 'photo' | 'video'

export interface AutopostMediaItem {
  type: AutopostMediaType
  path: string
}

export interface AutopostInlineButton {
  text: string
  url: string
}

export interface AutopostRecord {
  id: string
  text: string
  media: AutopostMediaItem[]
  inline_button: AutopostInlineButton | null
  target_channel_id: string
  channel_title: string | null
  status: AutopostStatus
  schedule_type: AutopostScheduleType
  scheduled_at: string
  recurring_time: string | null
  weekdays: number[] | null
  timezone: string
  last_sent_at: string | null
  last_error: string | null
  sent_count: number
  created_at: string
  updated_at: string
}

export interface CreateAutopostInput {
  text: string
  media?: AutopostMediaItem[]
  inline_button?: AutopostInlineButton | null
  target_channel_id: string
  channel_title?: string | null
  schedule_type: AutopostScheduleType
  scheduled_at: string
  recurring_time?: string | null
  weekdays?: number[] | null
  timezone?: string
}

export interface UpdateAutopostInput {
  text?: string
  media?: AutopostMediaItem[]
  inline_button?: AutopostInlineButton | null
  target_channel_id?: string
  channel_title?: string | null
  schedule_type?: AutopostScheduleType
  scheduled_at?: string
  recurring_time?: string | null
  weekdays?: number[] | null
  timezone?: string
  status?: AutopostStatus
}

interface AutopostDbRow {
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

function parseMediaJson(raw: string): AutopostMediaItem[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (m): m is AutopostMediaItem =>
        typeof m === 'object' &&
        m !== null &&
        (m as AutopostMediaItem).type !== undefined &&
        typeof (m as AutopostMediaItem).path === 'string' &&
        ((m as AutopostMediaItem).type === 'photo' || (m as AutopostMediaItem).type === 'video'),
    )
  } catch {
    return []
  }
}

function parseInlineButton(raw: string | null): AutopostInlineButton | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as AutopostInlineButton).text === 'string' &&
      typeof (parsed as AutopostInlineButton).url === 'string'
    ) {
      return { text: (parsed as AutopostInlineButton).text, url: (parsed as AutopostInlineButton).url }
    }
  } catch {
    /* ignore */
  }
  return null
}

function parseWeekdays(raw: string | null): number[] | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return null
    }
    const days = parsed.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
    return days.length > 0 ? days : null
  } catch {
    return null
  }
}

function rowToRecord(row: AutopostDbRow): AutopostRecord {
  const status = row.status as AutopostStatus
  const schedule_type = row.schedule_type as AutopostScheduleType
  return {
    id: row.id,
    text: row.text,
    media: parseMediaJson(row.media_json),
    inline_button: parseInlineButton(row.inline_button_json),
    target_channel_id: row.target_channel_id,
    channel_title: row.channel_title,
    status:
      status === 'active' || status === 'sent' || status === 'paused' || status === 'failed'
        ? status
        : 'active',
    schedule_type: schedule_type === 'recurring' ? 'recurring' : 'once',
    scheduled_at: row.scheduled_at,
    recurring_time: row.recurring_time,
    weekdays: parseWeekdays(row.weekdays_json),
    timezone: row.timezone || 'Europe/Moscow',
    last_sent_at: row.last_sent_at,
    last_error: row.last_error,
    sent_count: row.sent_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function listAutoposts(): AutopostRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM autoposts ORDER BY scheduled_at ASC')
    .all() as AutopostDbRow[]
  return rows.map(rowToRecord)
}

export function getAutopostById(id: string): AutopostRecord | null {
  const row = getDb().prepare('SELECT * FROM autoposts WHERE id = ?').get(id) as AutopostDbRow | undefined
  return row ? rowToRecord(row) : null
}

export function listDueAutoposts(nowIso: string): AutopostRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM autoposts
       WHERE status = 'active' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC`,
    )
    .all(nowIso) as AutopostDbRow[]
  return rows.map(rowToRecord)
}

export function createAutopost(input: CreateAutopostInput): AutopostRecord {
  const now = new Date().toISOString()
  const id = randomUUID()
  const media = input.media ?? []
  const weekdays = input.weekdays ?? null
  getDb()
    .prepare(
      `INSERT INTO autoposts (
        id, text, media_json, inline_button_json, target_channel_id, channel_title,
        status, schedule_type, scheduled_at, recurring_time, weekdays_json, timezone,
        last_sent_at, last_error, sent_count, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        'active', ?, ?, ?, ?, ?,
        NULL, NULL, 0, ?, ?
      )`,
    )
    .run(
      id,
      input.text,
      JSON.stringify(media),
      input.inline_button ? JSON.stringify(input.inline_button) : null,
      input.target_channel_id,
      input.channel_title ?? null,
      input.schedule_type,
      input.scheduled_at,
      input.recurring_time ?? null,
      weekdays ? JSON.stringify(weekdays) : null,
      input.timezone ?? 'Europe/Moscow',
      now,
      now,
    )
  return getAutopostById(id)!
}

export function updateAutopost(id: string, patch: UpdateAutopostInput): AutopostRecord | null {
  const current = getAutopostById(id)
  if (!current) {
    return null
  }
  const next: AutopostRecord = {
    ...current,
    text: patch.text ?? current.text,
    media: patch.media ?? current.media,
    inline_button: patch.inline_button !== undefined ? patch.inline_button : current.inline_button,
    target_channel_id: patch.target_channel_id ?? current.target_channel_id,
    channel_title: patch.channel_title !== undefined ? patch.channel_title : current.channel_title,
    schedule_type: patch.schedule_type ?? current.schedule_type,
    scheduled_at: patch.scheduled_at ?? current.scheduled_at,
    recurring_time: patch.recurring_time !== undefined ? patch.recurring_time : current.recurring_time,
    weekdays: patch.weekdays !== undefined ? patch.weekdays : current.weekdays,
    timezone: patch.timezone ?? current.timezone,
    status: patch.status ?? current.status,
    updated_at: new Date().toISOString(),
  }
  getDb()
    .prepare(
      `UPDATE autoposts SET
        text = ?, media_json = ?, inline_button_json = ?,
        target_channel_id = ?, channel_title = ?,
        status = ?, schedule_type = ?, scheduled_at = ?,
        recurring_time = ?, weekdays_json = ?, timezone = ?,
        updated_at = ?
       WHERE id = ?`,
    )
    .run(
      next.text,
      JSON.stringify(next.media),
      next.inline_button ? JSON.stringify(next.inline_button) : null,
      next.target_channel_id,
      next.channel_title,
      next.status,
      next.schedule_type,
      next.scheduled_at,
      next.recurring_time,
      next.weekdays ? JSON.stringify(next.weekdays) : null,
      next.timezone,
      next.updated_at,
      id,
    )
  return getAutopostById(id)
}

export function markAutopostSent(
  id: string,
  opts: { nextScheduledAt?: string; status?: AutopostStatus },
): AutopostRecord | null {
  const current = getAutopostById(id)
  if (!current) {
    return null
  }
  const now = new Date().toISOString()
  const status = opts.status ?? (current.schedule_type === 'once' ? 'sent' : 'active')
  const scheduledAt = opts.nextScheduledAt ?? current.scheduled_at
  getDb()
    .prepare(
      `UPDATE autoposts SET
        status = ?, scheduled_at = ?, last_sent_at = ?, last_error = NULL,
        sent_count = sent_count + 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(status, scheduledAt, now, now, id)
  return getAutopostById(id)
}

export function markAutopostFailed(id: string, error: string): AutopostRecord | null {
  const now = new Date().toISOString()
  getDb()
    .prepare(`UPDATE autoposts SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
    .run(error.slice(0, 2000), now, id)
  return getAutopostById(id)
}

export function deleteAutopost(id: string): boolean {
  const result = getDb().prepare('DELETE FROM autoposts WHERE id = ?').run(id)
  return result.changes > 0
}

export function setAutopostStatus(id: string, status: AutopostStatus): AutopostRecord | null {
  return updateAutopost(id, { status })
}

/** Удаляет автопосты, привязанные к TG-каналу (по абсолютному значению id). */
export function purgeAutopostsForChannel(channelId: string): number {
  const abs = String(Math.abs(Number.parseInt(channelId, 10) || 0))
  const rows = listAutoposts()
  let removed = 0
  for (const row of rows) {
    const rowAbs = String(Math.abs(Number.parseInt(row.target_channel_id, 10) || 0))
    if (rowAbs === abs && abs !== '0') {
      if (deleteAutopost(row.id)) {
        removed += 1
      }
    }
  }
  return removed
}
