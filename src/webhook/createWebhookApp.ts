import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'

import type { Bot } from '@maxhub/max-bot-api'
import type { Update } from '@maxhub/max-bot-api/types'
import compression from 'compression'
import express from 'express'

import { createAdminRouter } from '../api/adminRoutes'
import { listTgChainsSync } from '../api/adminPanelState'
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
import { getTelegramHealthSnapshot, probeTelegramBotApi, describeTelegramTokenSources } from '../services/telegramHealthService'
import { describeActiveProxyRuntime, getTelegramProxyApplyError } from '../utils/telegramProxyRuntime'

const MAX_SECRET_HEADER = 'x-max-bot-api-secret'

/** Корень `admin-panel/` рядом с `dist/` (в Docker: `/app/admin-panel`). */
const adminPanelRoot = join(__dirname, '..', '..', 'admin-panel')

/** Soft event-loop lag probe for /health (does not affect HTTP status). */
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
eventLoopDelay.enable()

function currentEventLoopLagMs(): number {
  // mean is in nanoseconds
  const meanNs = eventLoopDelay.mean
  if (!Number.isFinite(meanNs) || meanNs < 0) {
    return 0
  }
  return Math.round(meanNs / 1e6)
}

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
function isMiniappHtmlPath(url: string): boolean {
  const path = url.split('?')[0]
  return path === '/miniapp' || path === '/miniapp/' || path.endsWith('.html')
}

function isClientAbortError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false
  }
  const rec = err as { code?: unknown; message?: unknown }
  const code = typeof rec.code === 'string' ? rec.code : ''
  if (code === 'ECONNABORTED' || code === 'ECONNRESET' || code === 'EPIPE') {
    return true
  }
  const message = typeof rec.message === 'string' ? rec.message : ''
  return /aborted|EPIPE/i.test(message)
}

function logSendFileFailure(route: string, err: unknown): void {
  if (isClientAbortError(err)) {
    logger.debug(`${route}: client aborted sendFile`, err)
    return
  }
  logger.error(`${route}: sendFile failed`, err)
}

function applyMiniappHtmlHeaders(res: express.Response): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, no-transform')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
}

function applyMiniappAssetHeaders(res: express.Response, filePath: string): void {
  if (filePath.endsWith('.html')) {
    applyMiniappHtmlHeaders(res)
    return
  }
  if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
    // Version query on the HTML shell busts cache; allow phones to keep the file.
    res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400')
    return
  }
  if (/\.(png|jpe?g|webp|svg|gif)$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=604800')
  }
}

export function createHttpApp(options: HttpAppOptions): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(
    compression({
      threshold: 1024,
      filter: (req, res) => {
        if (req.headers['x-no-compression']) {
          return false
        }
        const url = String(req.originalUrl || req.url || '')
        // MAX WebView mishandles gzip HTML («техническая заминка»). JS/CSS/JSON are fine.
        if (isMiniappHtmlPath(url)) {
          return false
        }
        return compression.filter(req, res)
      },
    }),
  )

  app.get('/', (_req, res) => {
    res.redirect(302, '/admin')
  })

  app.get('/health', (_req, res) => {
    // Лёгкий ответ: COUNT по comments и тяжёлые JOIN здесь блокируют event loop / фронт.
    const chains = listTgChainsSync()
    res.status(200).json({
      ok: true,
      uptime: Math.round(process.uptime()),
      chains: {
        total: chains.length,
        active: chains.filter((c) => c.active).length,
        forwarding: chains.filter((c) => c.forward_posts).length,
        missing_discussion: chains.filter((c) => c.forward_comments && !c.tg_discussion_chat_id)
          .length,
      },
      memory: {
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      eventLoopLagMs: currentEventLoopLagMs(),
      timestamp: new Date().toISOString(),
    })
  })

  app.get('/health/telegram', async (_req, res) => {
    try {
      const snapshot = await probeTelegramBotApi()
      const sources = describeTelegramTokenSources()
      res.status(snapshot.api_ok || !snapshot.has_token ? 200 : 503).json({
        ...snapshot,
        token_sources: sources,
        proxy: describeActiveProxyRuntime(),
        proxy_error: getTelegramProxyApplyError(),
      })
    } catch (err: unknown) {
      logger.error('/health/telegram probe failed', err)
      res.status(503).json({
        checked_at: new Date().toISOString(),
        has_token: Boolean(getTelegramHealthSnapshot().has_token),
        api_ok: false,
        error: 'probe failed',
      })
    }
  })

  app.get('/favicon.ico', (_req, res) => {
    res.redirect(302, '/admin/assets/favicon.svg')
  })

  const sendAdminLogin = (_req: express.Request, res: express.Response): void => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.sendFile(join(adminPanelRoot, 'login.html'), (err) => {
      if (err) {
        logSendFileFailure('/admin/login', err)
        if (!res.headersSent) {
          res.status(500).end()
        }
      }
    })
  }
  app.get('/admin/login', sendAdminLogin)
  app.get('/admin/login/', sendAdminLogin)

  app.use(
    '/admin/assets',
    express.static(join(adminPanelRoot, 'assets'), {
      etag: true,
      lastModified: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
          res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
        }
      },
    }),
  )

  const sendAdminIndex = (req: express.Request, res: express.Response): void => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    if (!isAdminPanelSessionValid(req)) {
      res.redirect(302, '/admin/login')
      return
    }
    res.sendFile(join(adminPanelRoot, 'admin.html'), (err) => {
      if (err) {
        logSendFileFailure('/admin', err)
        if (!res.headersSent) {
          res.status(500).end()
        }
      }
    })
  }
  app.get('/admin', sendAdminIndex)
  app.get('/admin/', sendAdminIndex)

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
  const miniappIndex = join(miniappRoot, 'index.html')
  const sendMiniappIndex = (res: express.Response): void => {
    applyMiniappHtmlHeaders(res)
    res.sendFile(miniappIndex, (err) => {
      if (err) {
        logSendFileFailure('/miniapp', err)
        if (!res.headersSent) {
          res.status(500).end()
        }
      }
    })
  }
  /** Без редиректа на `/miniapp/` — WebView MAX/Telegram иногда не следует за 301. */
  app.get('/miniapp', (_req, res) => {
    sendMiniappIndex(res)
  })
  app.get('/miniapp/', (_req, res) => {
    sendMiniappIndex(res)
  })
  app.use(
    '/miniapp',
    express.static(miniappRoot, {
      etag: true,
      lastModified: true,
      redirect: false,
      setHeaders(res, filePath) {
        applyMiniappAssetHeaders(res, filePath)
      },
    }),
  )

  /** Cached HTML from `/miniapp` (no slash) requested `/app.js` instead of `/miniapp/app.js`. */
  app.get(['/app.js', '/styles.css', '/brand-logo.png'], (req, res, next) => {
    const referer = String(req.get('referer') || '')
    const fromMiniapp =
      /\/miniapp(\/|\?|$)/i.test(referer) ||
      String(req.query.v || '').length > 0
    if (!fromMiniapp) {
      next()
      return
    }
    const name = req.path === '/app.js' ? 'app.js' : req.path === '/styles.css' ? 'styles.css' : 'brand-logo.png'
    res.sendFile(join(miniappRoot, name), (err) => {
      if (err) {
        next()
      }
    })
  })

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

  app.use((req, res) => {
    const path = req.originalUrl || req.url || '/'
    logger.warn('HTTP 404', { method: req.method, path })
    if (req.accepts('html')) {
      res
        .status(404)
        .type('html')
        .send(
          `<!doctype html><meta charset="utf-8"><title>404</title>` +
            `<p>Нет страницы <code>${path.replace(/</g, '')}</code></p>` +
            `<p><a href="/admin">Админка</a> · <a href="/miniapp">Mini App</a> · <a href="/health">Health</a></p>`,
        )
      return
    }
    res.status(404).json({ error: 'not found', method: req.method, path })
  })

  return app
}

export function createWebhookApp(options: WebhookAppOptions): express.Express {
  return createHttpApp({
    bot: options.bot,
    webhook: { path: options.webhookPath, secret: options.webhookSecret },
  })
}
