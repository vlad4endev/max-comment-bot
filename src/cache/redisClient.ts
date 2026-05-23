import Redis from 'ioredis'

import { logger } from '../utils/logger'

let client: Redis | null = null
let initAttempted = false

export function getRedisUrl(): string | null {
  const url = (process.env.REDIS_URL ?? '').trim()
  return url !== '' ? url : null
}

export function isRedisConfigured(): boolean {
  return getRedisUrl() !== null
}

export type RedisInitStatus = 'disabled' | 'connected' | 'unavailable'

export async function initRedis(): Promise<RedisInitStatus> {
  const url = getRedisUrl()
  if (!url) {
    logger.info('redis: REDIS_URL not set — in-memory cache only')
    return 'disabled'
  }
  if (client && client.status === 'ready') {
    return 'connected'
  }

  const maxAttempts = 5
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (initAttempted && !client) {
      initAttempted = false
    }
    const status = await connectOnce(url)
    if (status === 'connected' || status === 'disabled') {
      return status
    }
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }
  return 'unavailable'
}

async function connectOnce(url: string): Promise<RedisInitStatus> {
  if (client && client.status === 'ready') {
    return 'connected'
  }
  if (initAttempted && !client) {
    return 'unavailable'
  }
  initAttempted = true
  try {
    const redis = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5_000,
      commandTimeout: 3_000,
      lazyConnect: true,
      retryStrategy: (times) => (times > 4 ? null : Math.min(times * 200, 2_000)),
    })
    redis.on('error', (err: unknown) => {
      logger.warn('redis: client error', { err: String(err) })
    })
    await redis.connect()
    client = redis
    logger.info('redis: connected')
    return 'connected'
  } catch (err: unknown) {
    logger.warn('redis: connect failed — in-memory cache only', { err: String(err) })
    try {
      await client?.quit()
    } catch {
      // ignore
    }
    client = null
    initAttempted = true
    return 'unavailable'
  }
}

export function getRedisClient(): Redis | null {
  if (!client || client.status !== 'ready') {
    return null
  }
  return client
}

export async function pingRedis(): Promise<boolean> {
  const redis = getRedisClient()
  if (!redis) {
    return false
  }
  try {
    return (await redis.ping()) === 'PONG'
  } catch {
    return false
  }
}

export async function disconnectRedis(): Promise<void> {
  if (!client) {
    return
  }
  try {
    await client.quit()
  } catch (err: unknown) {
    logger.warn('redis: quit error', { err: String(err) })
  } finally {
    client = null
  }
}
