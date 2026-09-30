/**
 * commentDeadLetterStore.ts
 *
 * Журнал комментариев, которые не перенеслись между Telegram и MAX.
 *  - kind 'dead'    — потеряны из-за сбоя (нет маппинга поста, «списаны» как недоставляемые); можно повторить;
 *  - kind 'skipped' — пропущены осознанно (бронь другой платформы, вложение без текста) — для прозрачности.
 * Раньше такие комментарии просто исчезали без следа.
 */

import { getDb } from '../db/database'
import { sendAdminAlert } from '../utils/alertService'
import { logger } from '../utils/logger'
import { upsertCommentInboundJob, parseInboundCommentMessage } from './tgChainForwardQueue'

export type DeadLetterDirection = 'tg_to_max' | 'max_to_tg'
export type DeadLetterKind = 'dead' | 'skipped'

export interface DeadLetterRow {
  id: number
  direction: DeadLetterDirection
  kind: DeadLetterKind
  chain_id: string
  ref_key: string
  discussion_chat_id: number | null
  tg_message_id: number | null
  comment_id: string | null
  reason: string
  last_error: string | null
  attempts: number
  payload: string | null
  created_at: number
  resolved_at: number | null
}

export const DEAD_LETTER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/**
 * Маркер «не доставлено»: отрицательный и уникальный.
 * База 2e15, чтобы не пересекаться с -1/-999 и с прежними маркерами вида -(unix_ms + random).
 */
export const UNDELIVERABLE_TG_COMMENT_ID_BASE = 2_000_000_000_000_000

export function recordDeadLetter(input: {
  direction: DeadLetterDirection
  kind: DeadLetterKind
  chainId: string
  refKey: string
  reason: string
  discussionChatId?: number | null
  tgMessageId?: number | null
  commentId?: string | null
  lastError?: string | null
  attempts?: number
  payload?: string | null
}): void {
  const result = getDb()
    .prepare(
      `INSERT INTO comment_sync_dead_letter
         (direction, kind, chain_id, ref_key, discussion_chat_id, tg_message_id, comment_id,
          reason, last_error, attempts, payload, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(direction, chain_id, ref_key) DO UPDATE SET
         kind = excluded.kind,
         reason = excluded.reason,
         last_error = excluded.last_error,
         attempts = excluded.attempts,
         payload = COALESCE(excluded.payload, comment_sync_dead_letter.payload),
         resolved_at = NULL`,
    )
    .run(
      input.direction,
      input.kind,
      input.chainId,
      input.refKey,
      input.discussionChatId ?? null,
      input.tgMessageId ?? null,
      input.commentId ?? null,
      input.reason,
      input.lastError?.slice(0, 500) ?? null,
      input.attempts ?? 0,
      input.payload ?? null,
      Date.now(),
    )
  if (input.kind === 'dead' && Number(result.changes) > 0) {
    logger.warn('[commentDeadLetter] comment moved to dead-letter', {
      chainId: input.chainId,
      direction: input.direction,
      refKey: input.refKey,
      reason: input.reason,
    })
    void sendAdminAlert(
      `comment_dead_letter:${input.chainId}`,
      'Комментарий не удалось перенести — он сохранён в журнале, его можно повторить в админке',
      { chainId: input.chainId, direction: input.direction, reason: input.reason },
    )
  }
}

export function listDeadLetters(options: {
  chainId?: string
  kind?: DeadLetterKind
  includeResolved?: boolean
  limit?: number
}): DeadLetterRow[] {
  const where: string[] = []
  const params: Array<string | number> = []
  if (options.chainId) {
    where.push('chain_id = ?')
    params.push(options.chainId)
  }
  if (options.kind) {
    where.push('kind = ?')
    params.push(options.kind)
  }
  if (!options.includeResolved) {
    where.push('resolved_at IS NULL')
  }
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
  return getDb()
    .prepare(
      `SELECT * FROM comment_sync_dead_letter
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(...params, limit) as DeadLetterRow[]
}

export function countOpenDeadLetters(): Array<{ chain_id: string; kind: string; n: number }> {
  return getDb()
    .prepare(
      `SELECT chain_id, kind, COUNT(*) AS n
       FROM comment_sync_dead_letter
       WHERE resolved_at IS NULL
       GROUP BY chain_id, kind`,
    )
    .all() as Array<{ chain_id: string; kind: string; n: number }>
}

export function resolveDeadLetter(id: number): boolean {
  const result = getDb()
    .prepare(
      'UPDATE comment_sync_dead_letter SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL',
    )
    .run(Date.now(), id)
  return Number(result.changes) > 0
}

/** Ставит комментарий на повторный перенос. `true` — поставлен, `false` — нечего повторять. */
export function retryDeadLetter(id: number): boolean {
  const row = getDb()
    .prepare('SELECT * FROM comment_sync_dead_letter WHERE id = ? AND resolved_at IS NULL')
    .get(id) as DeadLetterRow | undefined
  if (!row || row.kind !== 'dead') {
    return false
  }

  if (row.direction === 'tg_to_max') {
    const message = row.payload ? parseInboundCommentMessage(row.payload) : null
    if (!message || row.discussion_chat_id == null) {
      return false
    }
    // Вернёт задачу в очередь входящих комментариев с нулевым счётчиком попыток.
    upsertCommentInboundJob({
      chainId: row.chain_id,
      discussionChatId: row.discussion_chat_id,
      message,
    })
    return resolveDeadLetter(id)
  }

  // max_to_tg: снимаем метку «списан», цикл MAX→TG подхватит комментарий снова.
  if (!row.comment_id) {
    return false
  }
  const result = getDb()
    .prepare(
      `UPDATE comments SET tg_comment_id = NULL
       WHERE comment_id = ? AND tg_comment_id <= ?`,
    )
    .run(row.comment_id, -UNDELIVERABLE_TG_COMMENT_ID_BASE)
  if (Number(result.changes) > 0) {
    return resolveDeadLetter(id)
  }
  return false
}

export function purgeOldDeadLetters(): number {
  const cutoff = Date.now() - DEAD_LETTER_RETENTION_MS
  const result = getDb()
    .prepare(
      `DELETE FROM comment_sync_dead_letter
       WHERE created_at < ? AND (resolved_at IS NOT NULL OR kind = 'skipped')`,
    )
    .run(cutoff)
  return Number(result.changes) || 0
}
