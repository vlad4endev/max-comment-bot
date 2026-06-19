import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import express from 'express'
import multer from 'multer'

import { getTelegramToken } from '../config'
import { logger } from '../utils/logger'
import { buildTelegramLinkedChatsList } from '../services/integrationPlatformClient'
import { integrationsStore } from '../services/integrationsStore'
import {
  computeNextRecurringAt,
  extractRecurringTimeFromIso,
} from '../services/autopostSchedule'
import {
  computeAutopostStats,
  createAutopost,
  deleteAutopost,
  getAutopostById,
  listAutoposts,
  listAutopostsFiltered,
  listPostChannels,
  setAutopostStatus,
  updateAutopost,
  upsertPostChannel,
  type AutopostInlineButton,
  type AutopostInlineKeyboard,
  type AutopostMediaItem,
  type AutopostScheduleType,
  normalizeInlineKeyboard,
  normalizeAutopostTags,
  type AutopostTag,
  type AutopostStatus,
  markAutopostSent,
  markAutopostFailed,
  type AutopostRecord,
} from '../services/autopostStore'
import { channelRegistry } from '../services/channelRegistry'
import {
  createPostTemplate,
  deletePostTemplate,
  getPostTemplateById,
  listPostTemplates,
  updatePostTemplate,
} from '../services/postTemplateStore'
import { POSTS_DB_PATH } from '../db/postsDatabase'
import { triggerAutopostTick, getAutopostSchedulerStatus } from '../services/autopostScheduler'
import { resolveMaxToken, sendAutopostToMax } from '../services/autopostMaxSender'
import { sendAutopostToTelegram } from '../services/autopostTelegramSender'

const AUTOPOST_MEDIA_DIR = path.join(process.cwd(), 'data', 'autoposts-media')
const MAX_MEDIA_FILES = 10
const MAX_MEDIA_BYTES = 50 * 1024 * 1024

const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, cb) {
      fs.mkdirSync(AUTOPOST_MEDIA_DIR, { recursive: true })
      cb(null, AUTOPOST_MEDIA_DIR)
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || '').toLowerCase()
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.mov', '.webm'].includes(ext)
        ? ext
        : file.mimetype?.startsWith('video/')
          ? '.mp4'
          : '.jpg'
      cb(null, `${Date.now()}-${randomUUID()}${safeExt}`)
    },
  }),
  limits: { files: MAX_MEDIA_FILES, fileSize: MAX_MEDIA_BYTES },
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const t = value.trim()
  return t === '' ? null : t
}

function parseWeekdays(raw: unknown): number[] | null {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return parseWeekdays(JSON.parse(raw))
    } catch {
      return null
    }
  }
  if (!Array.isArray(raw)) {
    return null
  }
  const days = raw
    .map((d) => (typeof d === 'number' ? d : Number.parseInt(String(d), 10)))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  return days.length > 0 ? [...new Set(days)] : null
}

function mediaFromUploaded(files: Express.Multer.File[]): AutopostMediaItem[] {
  return files.map((f) => ({
    type: f.mimetype?.startsWith('video/') ? 'video' : 'photo',
    path: f.path,
  }))
}

const AUTOPOST_MEDIA_ROOT = path.resolve(AUTOPOST_MEDIA_DIR)

function sanitizeStoredMediaItem(item: unknown): AutopostMediaItem | null {
  if (typeof item !== 'object' || item === null) {
    return null
  }
  const row = item as { type?: string; path?: string }
  if (row.type !== 'photo' && row.type !== 'video') {
    return null
  }
  if (typeof row.path !== 'string' || !row.path.trim()) {
    return null
  }
  const resolved = path.resolve(row.path)
  if (!resolved.startsWith(AUTOPOST_MEDIA_ROOT + path.sep)) {
    return null
  }
  if (!fs.existsSync(resolved)) {
    return null
  }
  return { type: row.type, path: resolved }
}

function parseExistingMediaBody(raw: unknown): AutopostMediaItem[] {
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return parseExistingMediaBody(JSON.parse(raw))
    } catch {
      return []
    }
  }
  if (!Array.isArray(raw)) {
    return []
  }
  const out: AutopostMediaItem[] = []
  for (const item of raw) {
    const parsed = sanitizeStoredMediaItem(item)
    if (parsed) {
      out.push(parsed)
    }
  }
  return out
}

function mergeAutopostMedia(
  body: Record<string, unknown>,
  files: Express.Multer.File[],
): AutopostMediaItem[] {
  const kept = parseExistingMediaBody(body.existing_media)
  const uploaded = mediaFromUploaded(files)
  return [...kept, ...uploaded]
}

function resolveAutopostMediaFile(fileId: string): string | null {
  if (!fileId || fileId.includes('..') || fileId.includes('/') || fileId.includes('\\')) {
    return null
  }
  const resolved = path.resolve(AUTOPOST_MEDIA_DIR, fileId)
  if (!resolved.startsWith(AUTOPOST_MEDIA_ROOT + path.sep)) {
    return null
  }
  if (!fs.existsSync(resolved)) {
    return null
  }
  return resolved
}

function parseTagsFromBody(body: Record<string, unknown>): AutopostTag[] {
  const raw = body.tags
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed || trimmed === '[]') {
      return []
    }
    try {
      return normalizeAutopostTags(JSON.parse(trimmed))
    } catch {
      throw new Error('tags must be valid JSON')
    }
  }
  if (Array.isArray(raw)) {
    return normalizeAutopostTags(raw)
  }
  return []
}

function parseInlineButton(body: Record<string, unknown>): AutopostInlineButton | null {
  const text = parseNonEmptyString(body.inline_button_text)
  const url = parseNonEmptyString(body.inline_button_url)
  if (!text && !url) {
    return null
  }
  if (!text || !url) {
    throw new Error('inline_button_text and inline_button_url required together')
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('inline_button_url must start with http:// or https://')
  }
  return { text, url }
}

function parseInlineButtonsFromBody(body: Record<string, unknown>): AutopostInlineKeyboard | null {
  const raw = body.inline_buttons
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed || trimmed === '[]') {
      return null
    }
    try {
      return normalizeInlineKeyboard(JSON.parse(trimmed))
    } catch {
      throw new Error('inline_buttons must be valid JSON')
    }
  }
  if (Array.isArray(raw)) {
    return normalizeInlineKeyboard(raw)
  }
  const legacy = parseInlineButton(body)
  return legacy ? [[legacy]] : null
}

async function listTelegramChannelsForAutopost(): Promise<
  { id: string; title: string; username?: string; botIsAdmin?: boolean; platform: 'telegram' }[]
> {
  await integrationsStore.load()
  const integ = integrationsStore.getTelegramIntegration()
  if (!integ) {
    return []
  }
  const token = (integ.token || getTelegramToken()).trim()
  if (!token) {
    return []
  }
  const channels = await buildTelegramLinkedChatsList({
    integrationId: integ.id,
    token,
    existingLinkedChats: integ.linkedChats,
    refresh: false,
  })
  return channels
    .filter((c) => c.type === 'channel')
    .filter((c) => c.botIsAdmin === true)
    .map((c) => ({
      id: c.id,
      title: c.title,
      username: c.username,
      botIsAdmin: c.botIsAdmin,
      platform: 'telegram' as const,
    }))
}

function syncPostChannelsRegistry(): void {
  for (const ch of channelRegistry.getAllChannels()) {
    if (ch.type !== 'channel') continue
    upsertPostChannel({
      id: String(ch.chat_id),
      platform: 'max',
      title: ch.title ?? null,
    })
  }
}

function listMaxChannelsForAutopost(): {
  id: string
  title: string
  platform: 'max'
}[] {
  return channelRegistry
    .getAllChannels()
    .filter((ch) => ch.type === 'channel')
    .map((ch) => ({
      id: String(ch.chat_id),
      title: ch.title?.trim() || `Канал ${ch.chat_id}`,
      platform: 'max' as const,
    }))
}

function validateScheduleInput(body: Record<string, unknown>): {
  schedule_type: AutopostScheduleType
  scheduled_at: string
  recurring_time: string | null
  weekdays: number[] | null
  timezone: string
} {
  const timezone = parseNonEmptyString(body.timezone) ?? 'Europe/Moscow'
  const scheduleTypeRaw = parseNonEmptyString(body.schedule_type) ?? 'once'
  const schedule_type: AutopostScheduleType =
    scheduleTypeRaw === 'recurring' ? 'recurring' : 'once'
  const scheduled_at = parseNonEmptyString(body.scheduled_at)
  if (!scheduled_at || Number.isNaN(new Date(scheduled_at).getTime())) {
    throw new Error('scheduled_at required (ISO datetime)')
  }
  if (schedule_type === 'once') {
    return { schedule_type, scheduled_at, recurring_time: null, weekdays: null, timezone }
  }
  const recurring_time =
    parseNonEmptyString(body.recurring_time) ?? extractRecurringTimeFromIso(scheduled_at, timezone)
  const weekdays = parseWeekdays(body.weekdays)
  if (!weekdays?.length) {
    throw new Error('weekdays required for recurring schedule (0=Sun … 6=Sat)')
  }
  const nextAt = computeNextRecurringAt(recurring_time, weekdays, new Date(), timezone)
  return { schedule_type, scheduled_at: nextAt, recurring_time, weekdays, timezone }
}

function parseAutopostStatus(raw: unknown): AutopostStatus | undefined {
  if (raw !== 'draft' && raw !== 'active' && raw !== 'paused' && raw !== 'sent' && raw !== 'failed') {
    return undefined
  }
  return raw
}

async function publishAutopostNow(postId: string): Promise<{ ok: true; post: AutopostRecord }> {
  const post = getAutopostById(postId)
  if (!post) {
    throw new Error('not found')
  }
  if (post.platform === 'max') {
    const maxToken = resolveMaxToken()
    if (!maxToken) {
      throw new Error('MAX bot token not configured')
    }
    await sendAutopostToMax(maxToken, post)
  } else {
    const tgToken = getTelegramToken() || integrationsStore.getTelegramIntegration()?.token?.trim()
    if (!tgToken) {
      throw new Error('Telegram bot token not configured')
    }
    await sendAutopostToTelegram(tgToken, post)
  }
  if (post.schedule_type === 'once') {
    markAutopostSent(post.id, { status: 'sent' })
  } else if (post.recurring_time && post.weekdays?.length) {
    const nextAt = computeNextRecurringAt(
      post.recurring_time,
      post.weekdays,
      new Date(),
      post.timezone,
    )
    markAutopostSent(post.id, { nextScheduledAt: nextAt, status: 'active' })
  } else {
    markAutopostSent(post.id, { status: 'sent' })
  }
  const updated = getAutopostById(postId)
  if (!updated) {
    throw new Error('not found after publish')
  }
  return { ok: true, post: updated }
}

export function createAutopostRouter(): express.Router {
  const router = express.Router()

  router.get('/channels', async (_req, res) => {
    try {
      const tgChannels = await listTelegramChannelsForAutopost()
      for (const c of tgChannels) {
        upsertPostChannel({
          id: c.id,
          platform: 'telegram',
          title: c.title,
          username: c.username,
        })
      }
      syncPostChannelsRegistry()
      const maxChannels = listMaxChannelsForAutopost()
      const allChannels = [...tgChannels, ...maxChannels]
      const registered = listPostChannels()
      const integ = integrationsStore.getTelegramIntegration()
      const hints: string[] = []
      if (!tgChannels.length) {
        hints.push('Telegram: подключите интеграцию и добавьте бота админом в канал.')
      }
      if (!maxChannels.length) {
        hints.push('MAX: добавьте бота в канал — он появится в списке автоматически.')
      }
      res.json({
        connected: !!integ || maxChannels.length > 0,
        channels: allChannels,
        telegram: tgChannels,
        max: maxChannels,
        registered,
        db_path: POSTS_DB_PATH,
        hint: hints.length ? hints.join(' ') : null,
      })
    } catch (err: unknown) {
      logger.error('GET /autoposts/channels failed', err)
      res.status(500).json({ error: 'Не удалось загрузить каналы' })
    }
  })

  router.get('/templates', (_req, res) => {
    res.json({ templates: listPostTemplates() })
  })

  router.post('/templates', (req, res) => {
    const body = isRecord(req.body) ? req.body : {}
    const name = parseNonEmptyString(body.name)
    const text = parseNonEmptyString(body.text) ?? ''
    if (!name) {
      res.status(400).json({ error: 'name required' })
      return
    }
    const row = createPostTemplate({ name, text })
    res.json({ ok: true, template: row })
  })

  router.patch('/templates/:id', (req, res) => {
    const id = parseNonEmptyString(req.params.id)
    if (!id) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const body = isRecord(req.body) ? req.body : {}
    const row = updatePostTemplate(id, {
      name: body.name !== undefined ? (parseNonEmptyString(body.name) ?? undefined) : undefined,
      text: body.text !== undefined ? (parseNonEmptyString(body.text) ?? '') : undefined,
    })
    if (!row) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ ok: true, template: row })
  })

  router.delete('/templates/:id', (req, res) => {
    const id = parseNonEmptyString(req.params.id)
    if (!id) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    if (!deletePostTemplate(id)) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ ok: true })
  })

  router.get('/stats', async (_req, res) => {
    try {
      const channels = await listTelegramChannelsForAutopost()
      const posts = listAutoposts()
      res.json({ stats: computeAutopostStats(posts, channels.length), scheduler: getAutopostSchedulerStatus() })
    } catch (err: unknown) {
      logger.error('GET /autoposts/stats failed', err)
      res.status(500).json({ error: 'Не удалось загрузить статистику' })
    }
  })

  router.get('/scheduler', (_req, res) => {
    res.json({ scheduler: getAutopostSchedulerStatus() })
  })

  router.get('/', (req, res) => {
    const status = parseNonEmptyString(req.query.status) ?? undefined
    const channelId = parseNonEmptyString(req.query.channelId) ?? undefined
    const scheduleTypeRaw = parseNonEmptyString(req.query.scheduleType)
    const scheduleType: AutopostScheduleType | undefined =
      scheduleTypeRaw === 'recurring' || scheduleTypeRaw === 'once' ? scheduleTypeRaw : undefined
    const search = parseNonEmptyString(req.query.search) ?? undefined
    const from = parseNonEmptyString(req.query.from) ?? undefined
    const to = parseNonEmptyString(req.query.to) ?? undefined
    const tag = parseNonEmptyString(req.query.tag) ?? undefined
    const posts = listAutopostsFiltered({ status, channelId, scheduleType, search, tag, from, to })
    res.json({ posts })
  })

  router.get('/media/:fileId', (req, res) => {
    const fileId = parseNonEmptyString(req.params.fileId)
    if (!fileId) {
      res.status(400).json({ error: 'invalid file id' })
      return
    }
    const filePath = resolveAutopostMediaFile(fileId)
    if (!filePath) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.sendFile(filePath)
  })

  router.get('/:id', (req, res) => {
    const id = parseNonEmptyString(req.params.id)
    if (!id) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const row = getAutopostById(id)
    if (!row) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ post: row })
  })

  router.post('/', upload.array('media', MAX_MEDIA_FILES), async (req, res) => {
    try {
      const body = isRecord(req.body) ? req.body : {}
      const text = parseNonEmptyString(body.text) ?? ''
      const target_channel_id = parseNonEmptyString(body.target_channel_id)
      if (!target_channel_id) {
        res.status(400).json({ error: 'target_channel_id required' })
        return
      }
      if (!text && (!req.files || !(req.files as Express.Multer.File[]).length) && !parseExistingMediaBody(body.existing_media).length) {
        res.status(400).json({ error: 'text or media required' })
        return
      }
      const schedule = validateScheduleInput(body)
      const inline_buttons = parseInlineButtonsFromBody(body)
      const tags = parseTagsFromBody(body)
      const media = mergeAutopostMedia(body, (req.files as Express.Multer.File[]) ?? [])
      const platformRaw = parseNonEmptyString(body.platform)
      const platform = platformRaw === 'max' ? 'max' : 'telegram'
      const status = parseAutopostStatus(body.status) ?? 'active'
      if (media.length > 1 && inline_buttons && platform === 'telegram') {
        res.status(400).json({
          error: 'album_inline_button',
          message:
            'Инлайн-кнопка не поддерживается в альбоме Telegram. Используйте одно медиа или кнопку без альбома.',
        })
        return
      }
      const row = createAutopost({
        platform,
        text,
        media,
        inline_buttons,
        tags,
        target_channel_id,
        channel_title: parseNonEmptyString(body.channel_title),
        status,
        ...schedule,
      })
      logger.info('autopost created', {
        id: row.id,
        platform: row.platform,
        status: row.status,
        scheduled_at: row.scheduled_at,
        channel: row.target_channel_id,
      })
      triggerAutopostTick()
      res.json({ ok: true, post: row })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'invalid body'
      res.status(400).json({ error: message })
    }
  })

  router.patch('/:id', upload.array('media', MAX_MEDIA_FILES), async (req, res) => {
    const id = parseNonEmptyString(req.params.id)
    if (!id) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    try {
      const body = isRecord(req.body) ? req.body : {}
      const patch: Parameters<typeof updateAutopost>[1] = {}
      if (body.text !== undefined) {
        patch.text = parseNonEmptyString(body.text) ?? ''
      }
      if (body.target_channel_id !== undefined) {
        const tid = parseNonEmptyString(body.target_channel_id)
        if (!tid) {
          res.status(400).json({ error: 'target_channel_id invalid' })
          return
        }
        patch.target_channel_id = tid
      }
      if (body.channel_title !== undefined) {
        patch.channel_title = parseNonEmptyString(body.channel_title)
      }
      if (body.platform !== undefined) {
        const platformRaw = parseNonEmptyString(body.platform)
        patch.platform = platformRaw === 'max' ? 'max' : 'telegram'
      }
      if (body.inline_buttons !== undefined) {
        patch.inline_buttons = parseInlineButtonsFromBody(body)
      } else if (body.inline_button_text !== undefined || body.inline_button_url !== undefined) {
        patch.inline_buttons = parseInlineButtonsFromBody(body)
      }
      if (body.tags !== undefined) {
        patch.tags = parseTagsFromBody(body)
      }
      if (
        body.existing_media !== undefined ||
        (req.files && (req.files as Express.Multer.File[]).length > 0)
      ) {
        patch.media = mergeAutopostMedia(body, (req.files as Express.Multer.File[]) ?? [])
      }
      if (body.schedule_type !== undefined || body.scheduled_at !== undefined) {
        Object.assign(patch, validateScheduleInput(body))
      }
      if (body.status !== undefined) {
        const status = parseAutopostStatus(body.status)
        if (status) {
          patch.status = status
        }
      }
      const current = getAutopostById(id)
      if (!current) {
        res.status(404).json({ error: 'not found' })
        return
      }
      const nextMedia = patch.media ?? current.media
      const nextPlatform = patch.platform ?? current.platform
      const nextButtons =
        patch.inline_buttons !== undefined ? patch.inline_buttons : current.inline_buttons
      if (nextMedia.length > 1 && nextButtons && nextPlatform === 'telegram') {
        res.status(400).json({
          error: 'album_inline_button',
          message:
            'Инлайн-кнопки не поддерживаются в альбоме Telegram. Используйте одно медиа или кнопки без альбома.',
        })
        return
      }
      const row = updateAutopost(id, patch)
      if (!row) {
        res.status(404).json({ error: 'not found' })
        return
      }
      triggerAutopostTick()
      res.json({ ok: true, post: row })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'invalid body'
      res.status(400).json({ error: message })
    }
  })

  router.patch('/:id/pause', (req, res) => {
    const id = parseNonEmptyString(req.params.id)
    if (!id) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const row = setAutopostStatus(id, 'paused')
    if (!row) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ ok: true, post: row })
  })

  router.patch('/:id/resume', (req, res) => {
    const id = parseNonEmptyString(req.params.id)
    if (!id) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const current = getAutopostById(id)
    if (!current) {
      res.status(404).json({ error: 'not found' })
      return
    }
    let scheduled_at = current.scheduled_at
    if (current.schedule_type === 'recurring' && current.recurring_time && current.weekdays?.length) {
      scheduled_at = computeNextRecurringAt(
        current.recurring_time,
        current.weekdays,
        new Date(),
        current.timezone,
      )
    } else if (new Date(scheduled_at).getTime() <= Date.now()) {
      res.status(400).json({ error: 'scheduled_at in the past; update schedule first' })
      return
    }
    const row = updateAutopost(id, { status: 'active', scheduled_at })
    if (!row) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ ok: true, post: row })
  })

  router.post('/:id/publish-now', async (req, res) => {
    const id = parseNonEmptyString(req.params.id)
    if (!id) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    try {
      const result = await publishAutopostNow(id)
      res.json(result)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'not found') {
        res.status(404).json({ error: message })
        return
      }
      markAutopostFailed(id, message)
      res.status(502).json({ error: message })
    }
  })

  router.delete('/:id', (req, res) => {
    const id = parseNonEmptyString(req.params.id)
    if (!id) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const ok = deleteAutopost(id)
    if (!ok) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ ok: true })
  })

  return router
}
