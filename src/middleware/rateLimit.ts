import type express from 'express'

export interface RateLimitOptions {
  /** Имя для логов и ключа корзины. */
  name: string
  windowMs: number
  max: number
  /** Ключ корзины (по умолчанию IP клиента). */
  key?: (req: express.Request) => string
  /** Сообщение в поле `error` (клиенты Mini App показывают его как есть). */
  message?: string
  /** Не считать успешные (< 400) ответы — для логина: лимитируются только неудачные попытки. */
  skipSuccessful?: boolean
}

interface Bucket {
  count: number
  resetAt: number
}

const MAX_TRACKED_KEYS = 50_000

export function clientIp(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown'
}

/**
 * Лёгкий in-memory лимитер (фиксированное окно) без внешних зависимостей.
 * Состояние на процесс: для одного контейнера бота этого достаточно.
 */
export function createRateLimiter(options: RateLimitOptions): express.RequestHandler {
  const buckets = new Map<string, Bucket>()
  const message = options.message ?? 'Слишком много запросов. Попробуйте чуть позже.'

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) {
        buckets.delete(k)
      }
    }
  }, Math.max(options.windowMs, 30_000))
  sweep.unref()

  return (req, res, next) => {
    const now = Date.now()
    const key = `${options.name}:${(options.key ?? clientIp)(req)}`
    let bucket = buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      if (!bucket && buckets.size >= MAX_TRACKED_KEYS) {
        // Защита памяти при флуде с множества адресов: пропускаем, а не роняем сервис.
        next()
        return
      }
      bucket = { count: 0, resetAt: now + options.windowMs }
      buckets.set(key, bucket)
    }
    bucket.count += 1
    if (bucket.count > options.max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))))
      res.status(429).json({ error: message })
      return
    }
    if (options.skipSuccessful) {
      const current = bucket
      res.on('finish', () => {
        if (res.statusCode < 400 && current.count > 0) {
          current.count -= 1
        }
      })
    }
    next()
  }
}
