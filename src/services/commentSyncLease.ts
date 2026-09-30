/**
 * commentSyncLease.ts
 *
 * Аренда в SQLite: только один воркер шлёт конкретный комментарий/ответ на другую
 * платформу. Переживает рестарт, работает между циклом синхронизации и HTTP-роутами.
 * Просроченная аренда (упавший воркер) может быть перехвачена.
 */

import { getDb } from '../db/database'

export const DEFAULT_SYNC_LEASE_MS = 2 * 60_000

export function acquireSyncLease(key: string, ttlMs: number = DEFAULT_SYNC_LEASE_MS): boolean {
  const now = Date.now()
  const result = getDb()
    .prepare(
      `INSERT INTO comment_sync_lease (lease_key, expires_at) VALUES (?, ?)
       ON CONFLICT(lease_key) DO UPDATE SET expires_at = excluded.expires_at
       WHERE comment_sync_lease.expires_at <= ?`,
    )
    .run(key, now + ttlMs, now)
  return Number(result.changes) > 0
}

export function releaseSyncLease(key: string): void {
  getDb().prepare('DELETE FROM comment_sync_lease WHERE lease_key = ?').run(key)
}

/** Выполняет `work` под арендой; если аренда занята — возвращает `undefined` без вызова. */
export async function withSyncLease<T>(
  key: string,
  work: () => Promise<T>,
  ttlMs: number = DEFAULT_SYNC_LEASE_MS,
): Promise<T | undefined> {
  if (!acquireSyncLease(key, ttlMs)) {
    return undefined
  }
  try {
    return await work()
  } finally {
    releaseSyncLease(key)
  }
}

export function purgeExpiredSyncLeases(): number {
  const result = getDb()
    .prepare('DELETE FROM comment_sync_lease WHERE expires_at <= ?')
    .run(Date.now())
  return Number(result.changes) || 0
}
