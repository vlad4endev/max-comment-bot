import express from 'express'

import { checkAdminAuth } from '../middleware/adminAuth'
import {
  cancelChannelImportJob,
  createChannelImportJob,
  getActiveChannelImportJob,
  getChannelImportJob,
  publishChannelImportJob,
  readerTokenMeta,
  resolveImportTgToken,
  SCAN_IDLE_MAX,
  tickChannelImportJobs,
  toChannelImportJobView,
} from '../services/channelImportService'
import {
  confirmMtprotoLoginCode,
  confirmMtprotoPassword,
  getMtprotoStatus,
  logoutMtprotoSession,
  saveMtprotoCredentials,
  sendMtprotoLoginCode,
  testMtprotoConnection,
} from '../services/telegramMtprotoAuth'
import { telegramUserArchiveConfigured } from '../services/telegramUserArchive'

function parseJobId(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null
  }
  const n = Number.parseInt(raw, 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

export function createChannelImportRouter(): express.Router {
  const router = express.Router()
  router.use(express.json({ limit: '512kb' }))
  router.use(checkAdminAuth)

  router.get('/meta', async (_req, res) => {
    const tokenMeta = readerTokenMeta()
    let mtprotoStatus = null
    try {
      mtprotoStatus = await getMtprotoStatus()
    } catch {
      mtprotoStatus = null
    }
    res.json({
      scan_idle_max: SCAN_IDLE_MAX,
      scan_interval_ms: 2000,
      reader_token_ok: tokenMeta.ok,
      reader_uses_main_token: tokenMeta.usesMainToken,
      user_archive_ready: telegramUserArchiveConfigured(),
      mtproto: mtprotoStatus,
      hint: tokenMeta.ok
        ? tokenMeta.usesMainToken
          ? 'Используется TG_TOKEN из интеграции. Для импорта лучше задать отдельный TG_READER_BOT_TOKEN.'
          : null
        : 'Задайте TG_READER_BOT_TOKEN или подключите Telegram в интеграциях.',
      archive_hint: telegramUserArchiveConfigured()
        ? 'Режим «Архив канала» загрузит до N последних постов через user-аккаунт (MTProto).'
        : 'Настройте MTProto ниже (api_id, api_hash и вход по телефону) или переменные в .env.',
    })
  })

  router.get('/mtproto', async (_req, res) => {
    try {
      res.json(await getMtprotoStatus())
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'status failed'
      res.status(500).json({ error: msg })
    }
  })

  router.put('/mtproto/credentials', (req, res) => {
    const body = req.body as { api_id?: unknown; api_hash?: unknown }
    const apiIdRaw = body.api_id
    const apiId =
      typeof apiIdRaw === 'number'
        ? apiIdRaw
        : typeof apiIdRaw === 'string'
          ? Number.parseInt(apiIdRaw, 10)
          : NaN
    const apiHash = typeof body.api_hash === 'string' ? body.api_hash : ''
    try {
      saveMtprotoCredentials(apiId, apiHash)
      res.json({ ok: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'invalid credentials'
      res.status(400).json({ error: msg })
    }
  })

  router.post('/mtproto/send-code', async (req, res) => {
    const phone =
      typeof req.body?.phone === 'string'
        ? req.body.phone
        : req.body?.phone != null
          ? String(req.body.phone)
          : ''
    try {
      const result = await sendMtprotoLoginCode(phone)
      res.json({ ok: true, ...result })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'send code failed'
      res.status(400).json({ error: msg })
    }
  })

  router.post('/mtproto/confirm', async (req, res) => {
    const body = req.body as { login_id?: unknown; code?: unknown }
    const loginId = typeof body.login_id === 'string' ? body.login_id : ''
    const code = typeof body.code === 'string' ? body.code : ''
    try {
      const result = await confirmMtprotoLoginCode(loginId, code)
      if (!result.ok) {
        res.json({ ok: false, needs_password: true, login_id: result.login_id })
        return
      }
      res.json({ ok: true, user_display: result.user_display })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'confirm failed'
      res.status(400).json({ error: msg })
    }
  })

  router.post('/mtproto/password', async (req, res) => {
    const body = req.body as { login_id?: unknown; password?: unknown }
    const loginId = typeof body.login_id === 'string' ? body.login_id : ''
    const password = typeof body.password === 'string' ? body.password : ''
    try {
      const result = await confirmMtprotoPassword(loginId, password)
      res.json({ ok: true, user_display: result.user_display })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'password failed'
      res.status(400).json({ error: msg })
    }
  })

  router.post('/mtproto/test', async (_req, res) => {
    try {
      const result = await testMtprotoConnection()
      res.json({ ok: true, ...result })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'test failed'
      res.status(400).json({ error: msg })
    }
  })

  router.delete('/mtproto/session', (_req, res) => {
    logoutMtprotoSession()
    res.json({ ok: true })
  })

  router.get('/jobs/active', (_req, res) => {
    const job = getActiveChannelImportJob()
    if (!job) {
      res.json({ job: null })
      return
    }
    res.json({ job })
  })

  router.post('/jobs', (req, res) => {
    const body = req.body as {
      tg_channel?: unknown
      max_channel_id?: unknown
      archive?: unknown
      archive_limit?: unknown
    }
    const tg =
      typeof body.tg_channel === 'string'
        ? body.tg_channel
        : body.tg_channel != null
          ? String(body.tg_channel)
          : ''
    const max =
      typeof body.max_channel_id === 'string'
        ? body.max_channel_id
        : body.max_channel_id != null
          ? String(body.max_channel_id)
          : ''
    const archive = body.archive === true
    const archiveLimitRaw = body.archive_limit
    const archiveLimit =
      typeof archiveLimitRaw === 'number' && Number.isFinite(archiveLimitRaw)
        ? archiveLimitRaw
        : typeof archiveLimitRaw === 'string'
          ? Number.parseInt(archiveLimitRaw, 10)
          : 100

    try {
      const id = createChannelImportJob(tg, max, {
        archive,
        archiveLimit: Number.isFinite(archiveLimit) ? archiveLimit : 100,
      })
      if (!archive) {
        void tickChannelImportJobs().catch(() => {})
      }
      const job = getChannelImportJob(id)
      res.json({ ok: true, id, job: job ? toChannelImportJobView(job) : null })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'invalid request'
      res.status(400).json({ error: msg })
    }
  })

  router.get('/jobs/:id', (req, res) => {
    const id = parseJobId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const job = getChannelImportJob(id)
    if (!job) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json(toChannelImportJobView(job))
  })

  router.post('/jobs/:id/scan', async (req, res) => {
    const id = parseJobId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const job = getChannelImportJob(id)
    if (!job) {
      res.status(404).json({ error: 'not found' })
      return
    }
    if (job.status === 'archive_fetch') {
      res.json({ ok: true, job: toChannelImportJobView(job) })
      return
    }
    if (job.status !== 'scanning') {
      res.json({ ok: true, job: toChannelImportJobView(job) })
      return
    }
    await tickChannelImportJobs()
    const updated = getChannelImportJob(id)
    if (!updated) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ ok: true, job: toChannelImportJobView(updated) })
  })

  router.post('/jobs/:id/publish', async (req, res) => {
    const id = parseJobId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    try {
      await publishChannelImportJob(id, resolveImportTgToken(), process.env.BOT_TOKEN || '')
      res.json({ ok: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'publish failed'
      res.status(400).json({ error: msg })
    }
  })

  router.delete('/jobs/:id', (req, res) => {
    const id = parseJobId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    const ok = cancelChannelImportJob(id)
    if (!ok) {
      res.status(404).json({ error: 'not found' })
      return
    }
    res.json({ ok: true })
  })

  return router
}
