/**
 * commentSyncBackoff.ts
 *
 * Персистентный экспоненциальный бэкофф для отправки MAX→TG. Комментарий, который
 * раз за разом падает, уходит в паузу и не занимает место в батче — очередь не
 * «залипает» на нём, а остальные комментарии идут своим чередом.
 */

import { getDb } from '../db/database'

const BASE_DELAY_MS = 30_000
const MAX_DELAY_MS = 60 * 60_000

export function commentSendRetryKey(kind: 'comment' | 'reply', commentId: string): string {
  return `max-${kind}:${commentId}`
}

export function backoffDelayMs(attempts: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1))
}

export function recordSendFailure(key: string, minDelayMs = 0): number {
  const db = getDb()
  const row = db
    .prepare('SELECT attempts FROM comment_sync_backoff WHERE retry_key = ?')
    .get(key) as { attempts: number } | undefined
  const attempts = (row?.attempts ?? 0) + 1
  const delay = Math.max(minDelayMs, backoffDelayMs(attempts))
  db.prepare(
    `INSERT INTO comment_sync_backoff (retry_key, attempts, next_attempt_at) VALUES (?, ?, ?)
     ON CONFLICT(retry_key) DO UPDATE SET attempts = excluded.attempts, next_attempt_at = excluded.next_attempt_at`,
  ).run(key, attempts, Date.now() + delay)
  return attempts
}

export function clearSendFailure(key: string): void {
  getDb().prepare('DELETE FROM comment_sync_backoff WHERE retry_key = ?').run(key)
}

export function isInBackoff(key: string): boolean {
  const row = getDb()
    .prepare('SELECT next_attempt_at FROM comment_sync_backoff WHERE retry_key = ?')
    .get(key) as { next_attempt_at: number } | undefined
  return row != null && row.next_attempt_at > Date.now()
}

export function purgeStaleBackoff(): number {
  const result = getDb()
    .prepare('DELETE FROM comment_sync_backoff WHERE next_attempt_at < ?')
    .run(Date.now() - 24 * 60 * 60_000)
  return Number(result.changes) || 0
}
