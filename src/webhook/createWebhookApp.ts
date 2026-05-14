import type { Bot } from '@maxhub/max-bot-api'
import type { Update } from '@maxhub/max-bot-api/types'
import express from 'express'

import { logger } from '../utils/logger'
import { dispatchBotUpdate } from './dispatchUpdate'

const MAX_SECRET_HEADER = 'x-max-bot-api-secret'

export interface WebhookAppOptions {
  bot: Bot
  webhookPath: string
  /** Если задан — отклонять запросы без совпадающего заголовка `X-Max-Bot-Api-Secret` */
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

export function createWebhookApp(options: WebhookAppOptions): express.Express {
  const app = express()
  app.disable('x-powered-by')

  app.get('/health', (_req, res) => {
    res.status(200).type('text/plain').send('ok')
  })

  app.post(
    options.webhookPath,
    express.json({ limit: '512kb' }),
    async (req, res) => {
      if (options.webhookSecret) {
        const got = req.get(MAX_SECRET_HEADER)
        if (got !== options.webhookSecret) {
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
        await dispatchBotUpdate(options.bot, req.body)
        res.status(200).end()
      } catch (err) {
        logger.error('Webhook: ошибка обработки update', err)
        res.status(200).end()
      }
    },
  )

  return app
}
