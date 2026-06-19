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
  type AutopostMediaItem,
  type AutopostScheduleType,
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
} {
  const scheduleTypeRaw = parseNonEmptyString(body.schedule_type) ?? 'once'
  const schedule_type: AutopostScheduleType =
    scheduleTypeRaw === 'recurring' ? 'recurring' : 'once'
  const scheduled_at = parseNonEmptyString(body.scheduled_at)
  if (!scheduled_at || Number.isNaN(new Date(scheduled_at).getTime())) {
    throw new Error('scheduled_at required (ISO datetime)')
  }
  if (schedule_type === 'once') {
    return { schedule_type, scheduled_at, recurring_time: null, weekdays: null }
  }
  const recurring_time =
    parseNonEmptyString(body.recurring_time) ?? extractRecurringTimeFromIso(scheduled_at)
  const weekdays = parseWeekdays(body.weekdays)
  if (!weekdays?.length) {
    throw new Error('weekdays required for recurring schedule (0=Sun … 6=Sat)')
  }
  const nextAt = computeNextRecurringAt(recurring_time, weekdays)
  return { schedule_type, scheduled_at: nextAt, recurring_time, weekdays }
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
      res.json({ stats: computeAutopostStats(posts, channels.length) })
    } catch (err: unknown) {
      logger.error('GET /autoposts/stats failed', err)
      res.status(500).json({ error: 'Не удалось загрузить статистику' })
    }
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
    const posts = listAutopostsFiltered({ status, channelId, scheduleType, search, from, to })
    res.json({ posts })
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
      if (!text && (!req.files || !(req.files as Express.Multer.File[]).length)) {
        res.status(400).json({ error: 'text or media required' })
        return
      }
      const schedule = validateScheduleInput(body)
      const inline_button = parseInlineButton(body)
      const media = mediaFromUploaded((req.files as Express.Multer.File[]) ?? [])
      const platformRaw = parseNonEmptyString(body.platform)
      const platform = platformRaw === 'max' ? 'max' : 'telegram'
      if (media.length > 1 && inline_button && platform === 'telegram') {
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
        inline_button,
        target_channel_id,
        channel_title: parseNonEmptyString(body.channel_title),
        ...schedule,
      })
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
      if (body.inline_button_text !== undefined || body.inline_button_url !== undefined) {
        patch.inline_button = parseInlineButton(body)
      }
      if (req.files && (req.files as Express.Multer.File[]).length > 0) {
        patch.media = mediaFromUploaded(req.files as Express.Multer.File[])
      }
      if (body.schedule_type !== undefined || body.scheduled_at !== undefined) {
        Object.assign(patch, validateScheduleInput(body))
      }
      const row = updateAutopost(id, patch)
      if (!row) {
        res.status(404).json({ error: 'not found' })
        return
      }
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
      scheduled_at = computeNextRecurringAt(current.recurring_time, current.weekdays)
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
