import { randomUUID } from 'node:crypto'

import { getPostsDb, type PostPlatform } from '../db/postsDatabase'
import { isAutopostDue } from './autopostSchedule'

export type AutopostStatus = 'draft' | 'active' | 'sent' | 'paused' | 'failed'
export type AutopostScheduleType = 'once' | 'recurring'
export type AutopostMediaType = 'photo' | 'video'
export type AutopostOnFailure = 'skip' | 'retry_15m' | 'stop_series' | 'notify'

export interface AutopostMediaItem {
  type: AutopostMediaType
  path: string
}

/** Палитра цветов для тегов автопостов. */
export const AUTOPOST_TAG_COLORS = [
  '#7F77DD',
  '#1D9E75',
  '#BA7517',
  '#3B82F6',
  '#EC4899',
  '#EF4444',
  '#6B7280',
  '#EAB308',
] as const

export interface AutopostTag {
  name: string
  color: string
}

export interface AutopostInlineButton {
  text: string
  url: string
}

/** Rows of inline link buttons (each inner array = one row in Telegram / MAX). */
export type AutopostInlineKeyboard = AutopostInlineButton[][]

export interface AutopostCondition {
  id: string
  type: 'min_subscribers' | 'max_posts_per_day' | 'min_interval_hours' | 'hours_range' | 'weekdays_only'
  operator: '>=' | '<=' | '='
  value: string | number
}

export interface AutopostRecord {
  id: string
  platform: PostPlatform
  text: string
  media: AutopostMediaItem[]
  inline_button: AutopostInlineButton | null
  inline_buttons: AutopostInlineKeyboard | null
  tags: AutopostTag[]
  target_channel_id: string
  channel_title: string | null
  series_id: string | null
  status: AutopostStatus
  schedule_type: AutopostScheduleType
  scheduled_at: string
  recurring_time: string | null
  weekdays: number[] | null
  daily_times: string[] | null
  timezone: string
  start_date: string | null
  end_date: string | null
  repeat_limit: number | null
  on_failure: AutopostOnFailure
  conditions: AutopostCondition[]
  last_sent_at: string | null
  last_error: string | null
  sent_count: number
  platform_message_id: string | null
  created_at: string
  updated_at: string
}

export interface CreateAutopostInput {
  platform?: PostPlatform
  text: string
  media?: AutopostMediaItem[]
  inline_button?: AutopostInlineButton | null
  inline_buttons?: AutopostInlineKeyboard | null
  tags?: AutopostTag[]
  target_channel_id: string
  channel_title?: string | null
  series_id?: string | null
  schedule_type: AutopostScheduleType
  scheduled_at: string
  recurring_time?: string | null
  weekdays?: number[] | null
  daily_times?: string[] | null
  timezone?: string
  start_date?: string | null
  end_date?: string | null
  repeat_limit?: number | null
  on_failure?: AutopostOnFailure
  conditions?: AutopostCondition[]
  status?: AutopostStatus
}

export interface UpdateAutopostInput {
  platform?: PostPlatform
  text?: string
  media?: AutopostMediaItem[]
  inline_button?: AutopostInlineButton | null
  inline_buttons?: AutopostInlineKeyboard | null
  tags?: AutopostTag[]
  target_channel_id?: string
  channel_title?: string | null
  series_id?: string | null
  schedule_type?: AutopostScheduleType
  scheduled_at?: string
  recurring_time?: string | null
  weekdays?: number[] | null
  daily_times?: string[] | null
  timezone?: string
  start_date?: string | null
  end_date?: string | null
  repeat_limit?: number | null
  on_failure?: AutopostOnFailure
  conditions?: AutopostCondition[]
  status?: AutopostStatus
  platform_message_id?: string | null
}

export interface PostChannelRecord {
  id: string
  platform: PostPlatform
  title: string | null
  username: string | null
  color: string | null
  is_active: boolean
  subscribers_count: number
}

interface AutopostDbRow {
  id: string
  platform: string
  text: string
  media_json: string
  inline_button_json: string | null
  inline_buttons_json: string | null
  target_channel_id: string
  channel_title: string | null
  series_id: string | null
  status: string
  schedule_type: string
  scheduled_at: string
  recurring_time: string | null
  weekdays_json: string | null
  daily_times_json: string | null
  timezone: string
  start_date: string | null
  end_date: string | null
  repeat_limit: number | null
  on_failure: string
  conditions_json: string
  tags_json: string
  last_sent_at: string | null
  last_error: string | null
  sent_count: number
  platform_message_id: string | null
  created_at: string
  updated_at: string
}

function parseMediaJson(raw: string): AutopostMediaItem[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
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
  if (!raw) return null
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

function parseInlineButtonCell(raw: unknown): AutopostInlineButton | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as { text?: unknown; url?: unknown }
  if (typeof row.text !== 'string' || typeof row.url !== 'string') return null
  const text = row.text.trim()
  const url = row.url.trim()
  if (!text || !url || !/^https?:\/\//i.test(url)) return null
  return { text: text.slice(0, 64), url }
}

export function normalizeInlineKeyboard(input: unknown): AutopostInlineKeyboard | null {
  if (!Array.isArray(input) || input.length === 0) return null
  const rows: AutopostInlineKeyboard = []
  for (const rowRaw of input.slice(0, 8)) {
    if (!Array.isArray(rowRaw)) continue
    const row: AutopostInlineButton[] = []
    for (const cell of rowRaw.slice(0, 2)) {
      const btn = parseInlineButtonCell(cell)
      if (btn) row.push(btn)
    }
    if (row.length > 0) rows.push(row)
  }
  return rows.length > 0 ? rows : null
}

function parseInlineButtonsJson(
  buttonsRaw: string | null,
  legacyRaw: string | null,
): AutopostInlineKeyboard | null {
  if (buttonsRaw) {
    try {
      const parsed = normalizeInlineKeyboard(JSON.parse(buttonsRaw))
      if (parsed) return parsed
    } catch {
      /* ignore */
    }
  }
  const legacy = parseInlineButton(legacyRaw)
  return legacy ? [[legacy]] : null
}

export function primaryInlineButton(keyboard: AutopostInlineKeyboard | null): AutopostInlineButton | null {
  return keyboard?.[0]?.[0] ?? null
}

export function resolveInlineKeyboard(
  buttons?: AutopostInlineKeyboard | null,
  legacy?: AutopostInlineButton | null,
): AutopostInlineKeyboard | null {
  const normalized = normalizeInlineKeyboard(buttons ?? null)
  if (normalized) return normalized
  if (legacy?.text?.trim() && legacy.url?.trim()) {
    return [[{ text: legacy.text.trim().slice(0, 64), url: legacy.url.trim() }]]
  }
  return null
}

function isAllowedTagColor(color: string): boolean {
  const normalized = color.trim().toUpperCase()
  return AUTOPOST_TAG_COLORS.some((c) => c.toUpperCase() === normalized)
}

export function normalizeAutopostTags(input: unknown): AutopostTag[] {
  if (!Array.isArray(input)) return []
  const out: AutopostTag[] = []
  const seen = new Set<string>()
  for (const raw of input.slice(0, 10)) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as { name?: unknown; color?: unknown }
    const name =
      typeof row.name === 'string' ? row.name.trim().replace(/\s+/g, ' ').slice(0, 32) : ''
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    let color = typeof row.color === 'string' ? row.color.trim() : ''
    if (!isAllowedTagColor(color)) {
      color = AUTOPOST_TAG_COLORS[out.length % AUTOPOST_TAG_COLORS.length]
    }
    seen.add(key)
    out.push({ name, color })
  }
  return out
}

function parseTagsJson(raw: string | null | undefined): AutopostTag[] {
  if (!raw) return []
  try {
    return normalizeAutopostTags(JSON.parse(raw))
  } catch {
    return []
  }
}

function parseWeekdays(raw: string | null): number[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const days = parsed.filter((d): d is number => typeof d === 'number' && d >= 0 && d <= 6)
    return days.length > 0 ? days : null
  } catch {
    return null
  }
}

function parseStringArray(raw: string | null): string[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const items = parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    return items.length > 0 ? items : null
  } catch {
    return null
  }
}

function parseConditions(raw: string | null): AutopostCondition[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (c): c is AutopostCondition =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as AutopostCondition).id === 'string' &&
        typeof (c as AutopostCondition).type === 'string',
    )
  } catch {
    return []
  }
}

function parseOnFailure(raw: string): AutopostOnFailure {
  if (raw === 'retry_15m' || raw === 'stop_series' || raw === 'notify') return raw
  return 'skip'
}

function rowToRecord(row: AutopostDbRow): AutopostRecord {
  const status = row.status as AutopostStatus
  const schedule_type = row.schedule_type as AutopostScheduleType
  const platform: PostPlatform = row.platform === 'max' ? 'max' : 'telegram'
  const inline_buttons = parseInlineButtonsJson(row.inline_buttons_json, row.inline_button_json)
  return {
    id: row.id,
    platform,
    text: row.text,
    media: parseMediaJson(row.media_json),
    inline_buttons,
    inline_button: primaryInlineButton(inline_buttons),
    tags: parseTagsJson(row.tags_json),
    target_channel_id: row.target_channel_id,
    channel_title: row.channel_title,
    series_id: row.series_id,
    status:
      status === 'draft' ||
      status === 'active' ||
      status === 'sent' ||
      status === 'paused' ||
      status === 'failed'
        ? status
        : 'active',
    schedule_type: schedule_type === 'recurring' ? 'recurring' : 'once',
    scheduled_at: row.scheduled_at,
    recurring_time: row.recurring_time,
    weekdays: parseWeekdays(row.weekdays_json),
    daily_times: parseStringArray(row.daily_times_json),
    timezone: row.timezone || 'Europe/Moscow',
    start_date: row.start_date,
    end_date: row.end_date,
    repeat_limit: row.repeat_limit,
    on_failure: parseOnFailure(row.on_failure || 'skip'),
    conditions: parseConditions(row.conditions_json),
    last_sent_at: row.last_sent_at,
    last_error: row.last_error,
    sent_count: row.sent_count,
    platform_message_id: row.platform_message_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function upsertPostChannel(input: {
  id: string
  platform: PostPlatform
  title?: string | null
  username?: string | null
  color?: string | null
  subscribers_count?: number
}): void {
  getPostsDb()
    .prepare(
      `INSERT INTO post_channels (id, platform, title, username, color, subscribers_count, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
       ON CONFLICT(platform, id) DO UPDATE SET
         title = COALESCE(excluded.title, post_channels.title),
         username = COALESCE(excluded.username, post_channels.username),
         color = COALESCE(excluded.color, post_channels.color),
         subscribers_count = COALESCE(excluded.subscribers_count, post_channels.subscribers_count),
         updated_at = datetime('now')`,
    )
    .run(
      input.id,
      input.platform,
      input.title ?? null,
      input.username ?? null,
      input.color ?? null,
      input.subscribers_count ?? 0,
    )
}

export function listPostChannels(platform?: PostPlatform): PostChannelRecord[] {
  const rows = platform
    ? (getPostsDb()
        .prepare('SELECT * FROM post_channels WHERE platform = ? ORDER BY title ASC')
        .all(platform) as Array<{
        id: string
        platform: string
        title: string | null
        username: string | null
        color: string | null
        is_active: number
        subscribers_count: number
      }>)
    : (getPostsDb()
        .prepare('SELECT * FROM post_channels ORDER BY platform, title ASC')
        .all() as Array<{
        id: string
        platform: string
        title: string | null
        username: string | null
        color: string | null
        is_active: number
        subscribers_count: number
      }>)
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform === 'max' ? 'max' : 'telegram',
    title: r.title,
    username: r.username,
    color: r.color,
    is_active: r.is_active === 1,
    subscribers_count: r.subscribers_count,
  }))
}

export function logPostPublish(input: {
  autopost_id: string
  platform: PostPlatform
  target_channel_id: string
  status: 'success' | 'failed' | 'skipped'
  message?: string | null
}): void {
  getPostsDb()
    .prepare(
      `INSERT INTO post_publish_log (autopost_id, platform, target_channel_id, status, message)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.autopost_id,
      input.platform,
      input.target_channel_id,
      input.status,
      input.message?.slice(0, 2000) ?? null,
    )
}

export function listAutoposts(): AutopostRecord[] {
  const rows = getPostsDb()
    .prepare('SELECT * FROM autoposts ORDER BY scheduled_at ASC')
    .all() as AutopostDbRow[]
  return rows.map(rowToRecord)
}

export interface AutopostListFilters {
  status?: string
  channelId?: string
  platform?: PostPlatform
  scheduleType?: AutopostScheduleType
  search?: string
  tag?: string
  from?: string
  to?: string
}

export function listAutopostsFiltered(filters: AutopostListFilters = {}): AutopostRecord[] {
  let posts = listAutoposts()
  if (filters.status) posts = posts.filter((p) => p.status === filters.status)
  if (filters.platform) posts = posts.filter((p) => p.platform === filters.platform)
  if (filters.channelId) {
    const abs = String(Math.abs(Number.parseInt(filters.channelId, 10) || 0))
    posts = posts.filter((p) => {
      const rowAbs = String(Math.abs(Number.parseInt(p.target_channel_id, 10) || 0))
      return rowAbs === abs && abs !== '0'
    })
  }
  if (filters.scheduleType) posts = posts.filter((p) => p.schedule_type === filters.scheduleType)
  if (filters.search) {
    const q = filters.search.toLowerCase()
    posts = posts.filter(
      (p) =>
        p.text.toLowerCase().includes(q) ||
        p.tags.some((t) => t.name.toLowerCase().includes(q)),
    )
  }
  if (filters.tag) {
    const tagQ = filters.tag.toLowerCase()
    posts = posts.filter((p) => p.tags.some((t) => t.name.toLowerCase() === tagQ))
  }
  if (filters.from) {
    const fromMs = Date.parse(filters.from)
    if (Number.isFinite(fromMs)) posts = posts.filter((p) => Date.parse(p.scheduled_at) >= fromMs)
  }
  if (filters.to) {
    const toMs = Date.parse(filters.to)
    if (Number.isFinite(toMs)) posts = posts.filter((p) => Date.parse(p.scheduled_at) <= toMs)
  }
  return posts
}

export interface AutopostStats {
  totalPosts: number
  scheduledCount: number
  activeSeries: number
  connectedChannels: number
  totalSent: number
  successRate: number
  byChannel: { channelId: string; title: string; platform: PostPlatform; sent: number }[]
  heatmap: number[][]
}

export function computeAutopostStats(
  posts: AutopostRecord[],
  channelCount: number,
): AutopostStats {
  const scheduledCount = posts.filter((p) => p.status === 'active').length
  const activeSeries = posts.filter(
    (p) => p.schedule_type === 'recurring' && (p.status === 'active' || p.status === 'paused'),
  ).length
  const totalSent = posts.reduce((acc, p) => acc + p.sent_count, 0)
  const failedCount = posts.filter((p) => p.status === 'failed').length
  const attempts = totalSent + failedCount
  const successRate = attempts > 0 ? Math.round((totalSent / attempts) * 100) : 100

  const channelMap = new Map<string, { title: string; platform: PostPlatform; sent: number }>()
  for (const p of posts) {
    const key = `${p.platform}:${p.target_channel_id}`
    const cur = channelMap.get(key) ?? {
      title: p.channel_title || p.target_channel_id,
      platform: p.platform,
      sent: 0,
    }
    cur.sent += p.sent_count
    channelMap.set(key, cur)
  }
  const byChannel = [...channelMap.entries()]
    .map(([key, v]) => ({
      channelId: key.split(':').slice(1).join(':'),
      title: v.title,
      platform: v.platform,
      sent: v.sent,
    }))
    .sort((a, b) => b.sent - a.sent)

  const heatHours = [9, 12, 15, 18, 21]
  const heatmap: number[][] = Array.from({ length: 7 }, () => heatHours.map(() => 0))
  for (const p of posts) {
    if (p.sent_count <= 0) continue
    const ref = p.last_sent_at || p.scheduled_at
    const d = new Date(ref)
    if (Number.isNaN(d.getTime())) continue
    let day = d.getDay()
    day = day === 0 ? 6 : day - 1
    const hour = d.getHours()
    let col = heatHours.findIndex((h) => Math.abs(h - hour) <= 1)
    if (col < 0) col = 2
    heatmap[day][col] += p.sent_count
  }

  return {
    totalPosts: posts.length,
    scheduledCount,
    activeSeries,
    connectedChannels: channelCount,
    totalSent,
    successRate,
    byChannel,
    heatmap,
  }
}

export function getAutopostById(id: string): AutopostRecord | null {
  const row = getPostsDb().prepare('SELECT * FROM autoposts WHERE id = ?').get(id) as
    | AutopostDbRow
    | undefined
  return row ? rowToRecord(row) : null
}

export function listDueAutoposts(nowIso: string): AutopostRecord[] {
  const now = new Date(nowIso)
  const rows = getPostsDb()
    .prepare(
      `SELECT * FROM autoposts
       WHERE status = 'active'
       ORDER BY scheduled_at ASC`,
    )
    .all() as AutopostDbRow[]
  return rows
    .map(rowToRecord)
    .filter((post) => isAutopostDue(post.scheduled_at, now))
}

export function createAutopost(input: CreateAutopostInput): AutopostRecord {
  const now = new Date().toISOString()
  const id = randomUUID()
  const media = input.media ?? []
  const weekdays = input.weekdays ?? null
  const platform = input.platform ?? 'telegram'
  const status = input.status ?? 'active'
  const inline_buttons = resolveInlineKeyboard(input.inline_buttons, input.inline_button ?? null)
  const inline_button = primaryInlineButton(inline_buttons)
  const tags = normalizeAutopostTags(input.tags ?? [])

  upsertPostChannel({
    id: input.target_channel_id,
    platform,
    title: input.channel_title,
  })

  getPostsDb()
    .prepare(
      `INSERT INTO autoposts (
        id, platform, target_channel_id, channel_title, series_id, text, media_json,
        inline_button_json, inline_buttons_json, tags_json, status, schedule_type, scheduled_at, recurring_time,
        weekdays_json, daily_times_json, timezone, start_date, end_date, repeat_limit,
        on_failure, conditions_json, last_sent_at, last_error, sent_count, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, NULL, NULL, 0, ?, ?
      )`,
    )
    .run(
      id,
      platform,
      input.target_channel_id,
      input.channel_title ?? null,
      input.series_id ?? null,
      input.text,
      JSON.stringify(media),
      inline_button ? JSON.stringify(inline_button) : null,
      inline_buttons ? JSON.stringify(inline_buttons) : null,
      JSON.stringify(tags),
      status,
      input.schedule_type,
      input.scheduled_at,
      input.recurring_time ?? null,
      weekdays ? JSON.stringify(weekdays) : null,
      input.daily_times ? JSON.stringify(input.daily_times) : null,
      input.timezone ?? 'Europe/Moscow',
      input.start_date ?? null,
      input.end_date ?? null,
      input.repeat_limit ?? null,
      input.on_failure ?? 'skip',
      JSON.stringify(input.conditions ?? []),
      now,
      now,
    )
  return getAutopostById(id)!
}

export function updateAutopost(id: string, patch: UpdateAutopostInput): AutopostRecord | null {
  const current = getAutopostById(id)
  if (!current) return null

  const resolvedKeyboard =
    patch.inline_buttons !== undefined || patch.inline_button !== undefined
      ? resolveInlineKeyboard(
          patch.inline_buttons !== undefined ? patch.inline_buttons : current.inline_buttons,
          patch.inline_button !== undefined ? patch.inline_button : current.inline_button,
        )
      : current.inline_buttons

  const next: AutopostRecord = {
    ...current,
    platform: patch.platform ?? current.platform,
    text: patch.text ?? current.text,
    media: patch.media ?? current.media,
    inline_buttons: resolvedKeyboard,
    inline_button: primaryInlineButton(resolvedKeyboard),
    tags: patch.tags !== undefined ? normalizeAutopostTags(patch.tags) : current.tags,
    target_channel_id: patch.target_channel_id ?? current.target_channel_id,
    channel_title: patch.channel_title !== undefined ? patch.channel_title : current.channel_title,
    series_id: patch.series_id !== undefined ? patch.series_id : current.series_id,
    schedule_type: patch.schedule_type ?? current.schedule_type,
    scheduled_at: patch.scheduled_at ?? current.scheduled_at,
    recurring_time: patch.recurring_time !== undefined ? patch.recurring_time : current.recurring_time,
    weekdays: patch.weekdays !== undefined ? patch.weekdays : current.weekdays,
    daily_times: patch.daily_times !== undefined ? patch.daily_times : current.daily_times,
    timezone: patch.timezone ?? current.timezone,
    start_date: patch.start_date !== undefined ? patch.start_date : current.start_date,
    end_date: patch.end_date !== undefined ? patch.end_date : current.end_date,
    repeat_limit: patch.repeat_limit !== undefined ? patch.repeat_limit : current.repeat_limit,
    on_failure: patch.on_failure ?? current.on_failure,
    conditions: patch.conditions !== undefined ? patch.conditions : current.conditions,
    status: patch.status ?? current.status,
    platform_message_id:
      patch.platform_message_id !== undefined ? patch.platform_message_id : current.platform_message_id,
    updated_at: new Date().toISOString(),
  }

  if (patch.target_channel_id || patch.channel_title) {
    upsertPostChannel({
      id: next.target_channel_id,
      platform: next.platform,
      title: next.channel_title,
    })
  }

  getPostsDb()
    .prepare(
      `UPDATE autoposts SET
        platform = ?, text = ?, media_json = ?, inline_button_json = ?, inline_buttons_json = ?, tags_json = ?,
        target_channel_id = ?, channel_title = ?, series_id = ?,
        status = ?, schedule_type = ?, scheduled_at = ?,
        recurring_time = ?, weekdays_json = ?, daily_times_json = ?, timezone = ?,
        start_date = ?, end_date = ?, repeat_limit = ?,
        on_failure = ?, conditions_json = ?, platform_message_id = ?,
        updated_at = ?
       WHERE id = ?`,
    )
    .run(
      next.platform,
      next.text,
      JSON.stringify(next.media),
      next.inline_button ? JSON.stringify(next.inline_button) : null,
      next.inline_buttons ? JSON.stringify(next.inline_buttons) : null,
      JSON.stringify(next.tags),
      next.target_channel_id,
      next.channel_title,
      next.series_id,
      next.status,
      next.schedule_type,
      next.scheduled_at,
      next.recurring_time,
      next.weekdays ? JSON.stringify(next.weekdays) : null,
      next.daily_times ? JSON.stringify(next.daily_times) : null,
      next.timezone,
      next.start_date,
      next.end_date,
      next.repeat_limit,
      next.on_failure,
      JSON.stringify(next.conditions),
      next.platform_message_id,
      next.updated_at,
      id,
    )
  return getAutopostById(id)
}

export function markAutopostSent(
  id: string,
  opts: { nextScheduledAt?: string; status?: AutopostStatus; platformMessageId?: string },
): AutopostRecord | null {
  const current = getAutopostById(id)
  if (!current) return null
  const now = new Date().toISOString()
  const status = opts.status ?? (current.schedule_type === 'once' ? 'sent' : 'active')
  const scheduledAt = opts.nextScheduledAt ?? current.scheduled_at
  getPostsDb()
    .prepare(
      `UPDATE autoposts SET
        status = ?, scheduled_at = ?, last_sent_at = ?, last_error = NULL,
        sent_count = sent_count + 1,
        platform_message_id = COALESCE(?, platform_message_id),
        updated_at = ?
       WHERE id = ?`,
    )
    .run(status, scheduledAt, now, opts.platformMessageId ?? null, now, id)
  logPostPublish({
    autopost_id: id,
    platform: current.platform,
    target_channel_id: current.target_channel_id,
    status: 'success',
  })
  return getAutopostById(id)
}

export function markAutopostFailed(id: string, error: string): AutopostRecord | null {
  const current = getAutopostById(id)
  if (!current) return null
  const now = new Date().toISOString()
  const trimmedError = error.slice(0, 2000)

  if (current.on_failure === 'retry_15m') {
    const retryAt = new Date(Date.now() + 15 * 60_000).toISOString()
    getPostsDb()
      .prepare(
        `UPDATE autoposts SET status = 'active', scheduled_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(retryAt, trimmedError, now, id)
    logPostPublish({
      autopost_id: id,
      platform: current.platform,
      target_channel_id: current.target_channel_id,
      status: 'skipped',
      message: `retry at ${retryAt}: ${trimmedError}`,
    })
    return getAutopostById(id)
  }

  getPostsDb()
    .prepare(`UPDATE autoposts SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`)
    .run(trimmedError, now, id)
  logPostPublish({
    autopost_id: id,
    platform: current.platform,
    target_channel_id: current.target_channel_id,
    status: 'failed',
    message: error,
  })
  return getAutopostById(id)
}

export function deleteAutopost(id: string): boolean {
  const result = getPostsDb().prepare('DELETE FROM autoposts WHERE id = ?').run(id)
  return result.changes > 0
}

export function setAutopostStatus(id: string, status: AutopostStatus): AutopostRecord | null {
  return updateAutopost(id, { status })
}

export function purgeAutopostsForChannel(channelId: string, platform: PostPlatform = 'telegram'): number {
  const abs = String(Math.abs(Number.parseInt(channelId, 10) || 0))
  const rows = listAutoposts().filter((p) => p.platform === platform)
  let removed = 0
  for (const row of rows) {
    const rowAbs = String(Math.abs(Number.parseInt(row.target_channel_id, 10) || 0))
    if (rowAbs === abs && abs !== '0' && deleteAutopost(row.id)) {
      removed += 1
    }
  }
  return removed
}
