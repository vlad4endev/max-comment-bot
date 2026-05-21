import { join } from 'node:path'

import type { Bot } from '@maxhub/max-bot-api'
import type { Update } from '@maxhub/max-bot-api/types'
import express from 'express'

import { createAdminRouter } from '../api/adminRoutes'
import { createChannelImportRouter } from '../api/channelImportRoutes'
import {
  createFlowsRouter,
  createIntegrationsAnalyticsRouter,
  createIntegrationsRouter,
} from '../api/integrationsRoutes'
import { createCommentApiRouter } from '../api/routes'
import { isAdminPanelSessionValid } from '../middleware/adminAuth'
import { logger } from '../utils/logger'
import { enqueueUpdate } from '../utils/updateQueue'
import { dispatchBotUpdate } from './dispatchUpdate'

const MAX_SECRET_HEADER = 'x-max-bot-api-secret'

/** Корень `admin-panel/` рядом с `dist/` (в Docker: `/app/admin-panel`). */
const adminPanelRoot = join(__dirname, '..', '..', 'admin-panel')

export interface HttpAppOptions {
  bot: Bot
  /** Если задан — регистрируется POST webhook для MAX */
  webhook?: {
    path: string
    secret?: string
  }
}

/** @deprecated Используйте {@link HttpAppOptions} + {@link createHttpApp} */
export interface WebhookAppOptions {
  bot: Bot
  webhookPath: string
  webhookSecret?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function looksLikeUpdate(body: unknown): body is Update {
  if (!isRecord(body)) {
    return false
  }
  const type = body.update_type
  return typeof type === 'string' && type.length > 0
}

/**
 * Express-приложение: GET /health, статика Mini App (`/miniapp`), REST `/api`, опционально POST webhook.
 */
export function createHttpApp(options: HttpAppOptions): express.Express {
  const app = express()
  app.disable('x-powered-by')

  app.get('/health', (_req, res) => {
    res.status(200).type('text/plain').send('ok')
  })

  app.get('/favicon.ico', (_req, res) => {
    res.redirect(302, '/admin/assets/favicon.svg')
  })

  app.get('/admin/login', (_req, res) => {
    res.sendFile(join(adminPanelRoot, 'login.html'), (err) => {
      if (err) {
        logger.error('/admin/login: sendFile failed', err)
        if (!res.headersSent) {
          res.status(500).end()
        }
      }
    })
  })

  app.use(
    '/admin/assets',
    express.static(join(adminPanelRoot, 'assets'), {
      etag: true,
      lastModified: true,
    }),
  )

  app.get('/admin', (req, res) => {
    if (!isAdminPanelSessionValid(req)) {
      res.redirect(302, '/admin/login')
      return
    }
    res.sendFile(join(adminPanelRoot, 'admin.html'), (err) => {
      if (err) {
        logger.error('/admin: sendFile failed', err)
        if (!res.headersSent) {
          res.status(500).end()
        }
      }
    })
  })

  app.use('/api/admin', createAdminRouter({ bot: options.bot }))

  app.use('/api/channel-import', createChannelImportRouter())

  const integrationsDeps = { bot: options.bot }
  app.use('/api/integrations', createIntegrationsRouter(integrationsDeps))
  app.use('/api/flows', createFlowsRouter(integrationsDeps))
  app.use('/api/integrations-analytics', createIntegrationsAnalyticsRouter())

  app.use('/api', createCommentApiRouter({ bot: options.bot }))

  /** Unmatched /api/* → JSON (not nginx HTML) when the request reaches the bot. */
  app.use('/api', (req, res) => {
    res.status(404).json({
      error: 'API route not found',
      method: req.method,
      path: req.originalUrl,
    })
  })

  const miniappRoot = join(process.cwd(), 'miniapp')
  app.use(
    '/miniapp',
    express.static(miniappRoot, {
      etag: true,
      lastModified: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
          res.setHeader('Pragma', 'no-cache')
          res.setHeader('Expires', '0')
        }
      },
    }),
  )

  if (options.webhook) {
    const { path: webhookPath, secret: webhookSecret } = options.webhook
    app.post(
      webhookPath,
      express.json({ limit: '512kb' }),
      async (req, res) => {
        if (webhookSecret) {
          const got = req.get(MAX_SECRET_HEADER)
          if (got !== webhookSecret) {
            logger.warn('Webhook: отклонён запрос с неверным или пустым секретом')
            res.status(403).end()
            return
          }
        }

        if (!looksLikeUpdate(req.body)) {
          logger.warn('Webhook: тело запроса не похоже на Update')
          res.status(400).json({ error: 'invalid update payload' })
          return
        }

        try {
          await enqueueUpdate(() => dispatchBotUpdate(options.bot, req.body))
          res.status(200).end()
        } catch (err) {
          logger.error('Webhook: ошибка обработки update', err)
          res.status(200).end()
        }
      },
    )
  }

  return app
}

export function createWebhookApp(options: WebhookAppOptions): express.Express {
  return createHttpApp({
    bot: options.bot,
    webhook: { path: options.webhookPath, secret: options.webhookSecret },
  })
}
