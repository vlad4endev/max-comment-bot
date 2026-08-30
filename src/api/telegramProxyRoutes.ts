import express from 'express'

import { probeAllTelegramProxies, probeDirectTelegram, probeProxyRecord } from '../services/telegramProxyHealth'
import { telegramProxyStore } from '../services/telegramProxyStore'
import { applyTelegramProxyRuntime, describeActiveProxyRuntime } from '../utils/telegramProxyRuntime'
import { logger } from '../utils/logger'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePort(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value)
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number.parseInt(value, 10)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function publicPayload() {
  return {
    ...telegramProxyStore.toPublic(),
    runtime: describeActiveProxyRuntime(),
  }
}

async function applyAndRespond(res: express.Response, status = 200): Promise<void> {
  await applyTelegramProxyRuntime()
  res.status(status).json(publicPayload())
}

export function createTelegramProxyRouter(): express.Router {
  const router = express.Router()

  router.get('/', (_req, res) => {
    res.json(publicPayload())
  })

  router.post('/', async (req, res) => {
    try {
      const body = req.body
      if (!isRecord(body)) {
        res.status(400).json({ error: 'invalid body' })
        return
      }
      if (body.enabled !== undefined) {
        await telegramProxyStore.setEnabled(body.enabled === true)
      }
      if (body.local_socks_port !== undefined) {
        const port = parsePort(body.local_socks_port)
        if (port === null) {
          res.status(400).json({ error: 'Некорректный local_socks_port' })
          return
        }
        await telegramProxyStore.setLocalSocksPort(port)
      }
      await applyAndRespond(res)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Не удалось сохранить'
      res.status(400).json({ error: message })
    }
  })

  router.post('/replace', async (req, res) => {
    try {
      const body = req.body
      const text = isRecord(body) && typeof body.text === 'string' ? body.text : ''
      await telegramProxyStore.replaceAllFromText(text)
      await telegramProxyStore.setEnabled(true)
      await applyAndRespond(res)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Не удалось заменить ключи'
      res.status(400).json({ error: message })
    }
  })

  router.post('/items', async (req, res) => {
    try {
      const body = req.body
      if (!isRecord(body)) {
        res.status(400).json({ error: 'invalid body' })
        return
      }
      const name = typeof body.name === 'string' ? body.name : undefined
      if (typeof body.uri === 'string' && body.uri.trim()) {
        await telegramProxyStore.addFromInput(body.uri, name)
        await applyAndRespond(res, 201)
        return
      }
      const kind = body.kind === 'http' ? 'http' : 'socks5'
      const host = typeof body.host === 'string' ? body.host : ''
      const port = parsePort(body.port)
      if (!host || port === null) {
        res.status(400).json({ error: 'Укажите ссылку Hysteria2/VLESS или хост и порт прокси' })
        return
      }
      await telegramProxyStore.addSocksOrHttp({
        kind,
        host,
        port,
        username: typeof body.username === 'string' ? body.username : '',
        password: typeof body.password === 'string' ? body.password : '',
        name,
      })
      await applyAndRespond(res, 201)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Не удалось добавить прокси'
      res.status(400).json({ error: message })
    }
  })

  router.patch('/items/:id', async (req, res) => {
    try {
      const id = String(req.params.id ?? '')
      const body = req.body
      if (!isRecord(body)) {
        res.status(400).json({ error: 'invalid body' })
        return
      }
      await telegramProxyStore.updateItem(id, {
        name: typeof body.name === 'string' ? body.name : undefined,
        uri: typeof body.uri === 'string' ? body.uri : undefined,
        host: typeof body.host === 'string' ? body.host : undefined,
        port: body.port !== undefined ? (parsePort(body.port) ?? undefined) : undefined,
        username: typeof body.username === 'string' ? body.username : undefined,
        password: typeof body.password === 'string' ? body.password : undefined,
      })
      await applyAndRespond(res)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Не удалось обновить'
      res.status(400).json({ error: message })
    }
  })

  router.delete('/items/:id', async (req, res) => {
    try {
      await telegramProxyStore.removeItem(String(req.params.id ?? ''))
      await applyAndRespond(res)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Не удалось удалить'
      res.status(400).json({ error: message })
    }
  })

  router.post('/items/:id/activate', async (req, res) => {
    try {
      await telegramProxyStore.activate(String(req.params.id ?? ''))
      await applyAndRespond(res)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Не удалось включить прокси'
      res.status(400).json({ error: message })
    }
  })

  router.post('/probe', async (_req, res) => {
    try {
      await probeAllTelegramProxies()
      res.json(publicPayload())
    } catch (err: unknown) {
      logger.warn('telegram proxy probe-all failed', { err })
      const message = err instanceof Error ? err.message : 'Не удалось проверить связь'
      res.status(500).json({ error: message })
    }
  })

  router.post('/probe/direct', async (_req, res) => {
    try {
      await probeDirectTelegram()
      res.json(publicPayload())
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Не удалось проверить связь'
      res.status(500).json({ error: message })
    }
  })

  router.post('/items/:id/probe', async (req, res) => {
    try {
      const item = telegramProxyStore.getById(String(req.params.id ?? ''))
      if (!item) {
        res.status(404).json({ error: 'Прокси не найден' })
        return
      }
      await probeProxyRecord(item)
      res.json(publicPayload())
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Не удалось проверить связь'
      res.status(400).json({ error: message })
    }
  })

  return router
}
