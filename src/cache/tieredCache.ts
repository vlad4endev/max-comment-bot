import { getRedisClient } from './redisClient'
import { logger } from '../utils/logger'

interface MemoryEntry {
  value: string
  expiresAt: number
}

const memory = new Map<string, MemoryEntry>()

function memoryGet(key: string): string | null {
  const entry = memory.get(key)
  if (!entry) {
    return null
  }
  if (Date.now() >= entry.expiresAt) {
    memory.delete(key)
    return null
  }
  return entry.value
}

function memorySet(key: string, value: string, ttlSec: number): void {
  memory.set(key, {
    value,
    expiresAt: Date.now() + ttlSec * 1000,
  })
  if (memory.size > 5_000) {
    pruneMemory()
  }
}

function pruneMemory(): void {
  const now = Date.now()
  for (const [key, entry] of memory) {
    if (now >= entry.expiresAt) {
      memory.delete(key)
    }
  }
}

function prefixKey(key: string): string {
  return `mc:${key}`
}

export async function cacheGetJson<T>(key: string): Promise<T | null> {
  const fullKey = prefixKey(key)
  const local = memoryGet(fullKey)
  if (local !== null) {
    try {
      return JSON.parse(local) as T
    } catch {
      memory.delete(fullKey)
    }
  }
  const redis = getRedisClient()
  if (!redis) {
    return null
  }
  try {
    const raw = await redis.get(fullKey)
    if (raw === null) {
      return null
    }
    memorySet(fullKey, raw, 60)
    return JSON.parse(raw) as T
  } catch (err: unknown) {
    logger.warn('tieredCache: redis GET failed', { key, err: String(err) })
    return null
  }
}

export async function cacheSetJson(key: string, value: unknown, ttlSec: number): Promise<void> {
  const fullKey = prefixKey(key)
  const serialized = JSON.stringify(value)
  memorySet(fullKey, serialized, ttlSec)
  const redis = getRedisClient()
  if (!redis) {
    return
  }
  try {
    await redis.set(fullKey, serialized, 'EX', Math.max(1, ttlSec))
  } catch (err: unknown) {
    logger.warn('tieredCache: redis SET failed', { key, err: String(err) })
  }
}

export async function cacheGetOrCompute<T>(
  key: string,
  ttlSec: number,
  compute: () => Promise<T>,
): Promise<T> {
  const cached = await cacheGetJson<T>(key)
  if (cached !== null) {
    return cached
  }
  const value = await compute()
  await cacheSetJson(key, value, ttlSec)
  return value
}

/**
 * Distributed lock / dedup: returns true if lock acquired (SET NX EX).
 * Falls back to in-process memory when Redis is unavailable.
 */
export async function cacheTryAcquireLock(lockKey: string, ttlSec: number): Promise<boolean> {
  const fullKey = prefixKey(`lock:${lockKey}`)
  const redis = getRedisClient()
  if (redis) {
    try {
      const result = await redis.set(fullKey, '1', 'EX', Math.max(1, ttlSec), 'NX')
      if (result === 'OK') {
        return true
      }
      return false
    } catch (err: unknown) {
      logger.warn('tieredCache: redis lock failed', { lockKey, err: String(err) })
    }
  }
  const existing = memoryGet(fullKey)
  if (existing !== null) {
    return false
  }
  memorySet(fullKey, '1', ttlSec)
  return true
}

export async function cacheDelete(key: string): Promise<void> {
  const fullKey = prefixKey(key)
  memory.delete(fullKey)
  const redis = getRedisClient()
  if (!redis) {
    return
  }
  try {
    await redis.del(fullKey)
  } catch (err: unknown) {
    logger.warn('tieredCache: redis DEL failed', { key, err: String(err) })
  }
}
