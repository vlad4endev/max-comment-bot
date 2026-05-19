import express from 'express'

import { checkAdminAuth } from '../middleware/adminAuth'
import {
  cancelChannelImportJob,
  createChannelImportJob,
  getChannelImportJob,
  publishChannelImportJob,
} from '../services/channelImportService'

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

  router.post('/jobs', (req, res) => {
    const body = req.body as { tg_channel?: unknown; max_channel_id?: unknown }
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
    try {
      const id = createChannelImportJob(tg, max)
      res.json({ ok: true, id })
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
    res.json(job)
  })

  router.post('/jobs/:id/publish', async (req, res) => {
    const id = parseJobId(req.params.id)
    if (id === null) {
      res.status(400).json({ error: 'invalid id' })
      return
    }
    try {
      await publishChannelImportJob(
        id,
        process.env.TG_READER_BOT_TOKEN || '',
        process.env.BOT_TOKEN || '',
      )
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
