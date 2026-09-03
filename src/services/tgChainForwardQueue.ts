import { getDb } from '../db/database'
import type { TgMessage } from '../forwarder/telegramReader'

export type TgChainForwardQueueJob = {
  job_key: string
  chain_id: string
  tg_token: string
  payload: string
  attempts: number
  next_retry_at: number
  last_error: string | null
  created_at: number
}

export type ForwardQueueJobView = {
  job_key: string
  chain_id: string
  attempts: number
  next_retry_at: number
  last_error: string | null
  created_at: number
  message_ids: number[]
}

export type CommentQueueJobView = {
  job_key: string
  chain_id: string
  attempts: number
  next_retry_at: number
  last_error: string | null
  created_at: number
  message_id: number | null
}

export type ChainQueueSummary = {
  count: number
  oldestCreatedAt: number | null
  maxAttempts: number
  lastError: string | null
}

const MAX_RETRY_DELAY_MS = 30_000
/** Комментарий ждёт маппинг поста — не разгонять backoff до минут. */
export const COMMENT_MAPPING_RETRY_MS = 500

export function retryDelayMs(attempts: number): number {
  const exp = Math.min(Math.max(attempts, 1), 5)
  return Math.min(1_000 * 2 ** (exp - 1), MAX_RETRY_DELAY_MS)
}

export function mergeForwardQueueMessages(
  existing: TgMessage[],
  incoming: TgMessage[],
): TgMessage[] {
  const byId = new Map<number, TgMessage>()
  for (const msg of existing) {
    byId.set(msg.message_id, msg)
  }
  for (const msg of incoming) {
    byId.set(msg.message_id, msg)
  }
  return [...byId.values()].sort((a, b) => a.message_id - b.message_id)
}

export function getForwardQueueJob(jobKey: string): TgChainForwardQueueJob | null {
  const row = getDb()
    .prepare(
      `SELECT job_key, chain_id, tg_token, payload, attempts, next_retry_at, last_error, created_at
       FROM tg_chain_forward_queue
       WHERE job_key = ?`,
    )
    .get(jobKey) as TgChainForwardQueueJob | undefined
  return row ?? null
}

export function upsertForwardQueueJob(input: {
  jobKey: string
  chainId: string
  tgToken: string
  messages: TgMessage[]
  nextRetryAt: number
}): void {
  const existing = getForwardQueueJob(input.jobKey)
  const messages = existing
    ? mergeForwardQueueMessages(parseForwardQueueMessages(existing.payload), input.messages)
    : input.messages
  getDb()
    .prepare(
      `INSERT INTO tg_chain_forward_queue
         (job_key, chain_id, tg_token, payload, attempts, next_retry_at, last_error, created_at)
       VALUES (?, ?, ?, ?, 0, ?, NULL, ?)
       ON CONFLICT(job_key) DO UPDATE SET
         chain_id = excluded.chain_id,
         tg_token = excluded.tg_token,
         payload = excluded.payload,
         next_retry_at = excluded.next_retry_at`,
    )
    .run(
      input.jobKey,
      input.chainId,
      input.tgToken,
      JSON.stringify(messages),
      input.nextRetryAt,
      Date.now(),
    )
}

export function bumpForwardQueueRetry(jobKey: string, err: unknown): number {
  const row = getDb()
    .prepare('SELECT attempts FROM tg_chain_forward_queue WHERE job_key = ?')
    .get(jobKey) as { attempts: number } | undefined
  const attempts = (row?.attempts ?? 0) + 1
  const lastError = err instanceof Error ? err.message.slice(0, 500) : String(err ?? 'forward failed').slice(0, 500)
  getDb()
    .prepare(
      `UPDATE tg_chain_forward_queue
       SET attempts = ?, next_retry_at = ?, last_error = ?
       WHERE job_key = ?`,
    )
    .run(attempts, Date.now() + retryDelayMs(attempts), lastError, jobKey)
  return attempts
}

export function deleteForwardQueueJob(jobKey: string): void {
  getDb().prepare('DELETE FROM tg_chain_forward_queue WHERE job_key = ?').run(jobKey)
}

export function listDueForwardQueueJobs(limit = 40): TgChainForwardQueueJob[] {
  return getDb()
    .prepare(
      `SELECT job_key, chain_id, tg_token, payload, attempts, next_retry_at, last_error, created_at
       FROM tg_chain_forward_queue
       WHERE next_retry_at <= ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(Date.now(), limit) as TgChainForwardQueueJob[]
}

function summarizeQueueRows(
  rows: Array<{ chain_id: string; attempts: number; last_error: string | null; created_at: number }>,
): Map<string, ChainQueueSummary> {
  const byChain = new Map<string, ChainQueueSummary>()
  for (const row of rows) {
    const prev = byChain.get(row.chain_id)
    if (!prev) {
      byChain.set(row.chain_id, {
        count: 1,
        oldestCreatedAt: row.created_at,
        maxAttempts: row.attempts,
        lastError: row.last_error,
      })
      continue
    }
    prev.count += 1
    if (prev.oldestCreatedAt == null || row.created_at < prev.oldestCreatedAt) {
      prev.oldestCreatedAt = row.created_at
    }
    if (row.attempts > prev.maxAttempts) {
      prev.maxAttempts = row.attempts
      if (row.last_error) {
        prev.lastError = row.last_error
      }
    } else if (!prev.lastError && row.last_error) {
      prev.lastError = row.last_error
    }
  }
  return byChain
}

export function listForwardQueueJobViews(limit = 80): ForwardQueueJobView[] {
  const rows = getDb()
    .prepare(
      `SELECT job_key, chain_id, payload, attempts, next_retry_at, last_error, created_at
       FROM tg_chain_forward_queue
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    job_key: string
    chain_id: string
    payload: string
    attempts: number
    next_retry_at: number
    last_error: string | null
    created_at: number
  }>
  return rows.map((row) => ({
    job_key: row.job_key,
    chain_id: row.chain_id,
    attempts: row.attempts,
    next_retry_at: row.next_retry_at,
    last_error: row.last_error,
    created_at: row.created_at,
    message_ids: parseForwardQueueMessages(row.payload).map((m) => m.message_id),
  }))
}

export function summarizeForwardQueueByChain(): Map<string, ChainQueueSummary> {
  const rows = getDb()
    .prepare(
      `SELECT chain_id, attempts, last_error, created_at
       FROM tg_chain_forward_queue`,
    )
    .all() as Array<{ chain_id: string; attempts: number; last_error: string | null; created_at: number }>
  return summarizeQueueRows(rows)
}

export function countForwardQueueJobs(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM tg_chain_forward_queue')
    .get() as { n: number }
  return row.n
}

export function countCommentInboundJobs(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM tg_comment_inbound_queue')
    .get() as { n: number }
  return row.n
}

export function parseForwardQueueMessages(payload: string): TgMessage[] {
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter((item): item is TgMessage => {
      if (typeof item !== 'object' || item === null) {
        return false
      }
      const msg = item as TgMessage
      return typeof msg.message_id === 'number' && typeof msg.chat?.id === 'number'
    })
  } catch {
    return []
  }
}

export type TgCommentInboundJob = {
  job_key: string
  chain_id: string
  discussion_chat_id: number
  payload: string
  attempts: number
  last_error: string | null
  created_at: number
}

export function upsertCommentInboundJob(input: {
  chainId: string
  discussionChatId: number
  message: TgMessage
}): string {
  const jobKey = `${input.chainId}:${input.message.message_id}`
  getDb()
    .prepare(
      `INSERT INTO tg_comment_inbound_queue
         (job_key, chain_id, discussion_chat_id, payload, attempts, next_retry_at, last_error, created_at)
       VALUES (?, ?, ?, ?, 0, ?, NULL, ?)
       ON CONFLICT(job_key) DO UPDATE SET
         payload = excluded.payload,
         discussion_chat_id = excluded.discussion_chat_id`,
    )
    .run(
      jobKey,
      input.chainId,
      input.discussionChatId,
      JSON.stringify(input.message),
      Date.now(),
      Date.now(),
    )
  return jobKey
}

export function bumpCommentInboundRetry(
  jobKey: string,
  err: unknown,
  delayMs?: number,
): number {
  const row = getDb()
    .prepare('SELECT attempts FROM tg_comment_inbound_queue WHERE job_key = ?')
    .get(jobKey) as { attempts: number } | undefined
  const attempts = (row?.attempts ?? 0) + 1
  const lastError = err instanceof Error ? err.message.slice(0, 500) : String(err ?? 'retry').slice(0, 500)
  const waitMs = delayMs ?? retryDelayMs(attempts)
  getDb()
    .prepare(
      `UPDATE tg_comment_inbound_queue
       SET attempts = ?, next_retry_at = ?, last_error = ?
       WHERE job_key = ?`,
    )
    .run(attempts, Date.now() + waitMs, lastError, jobKey)
  return attempts
}

export function nudgeCommentInboundJobs(chainId: string): number {
  const result = getDb()
    .prepare(
      `UPDATE tg_comment_inbound_queue
       SET next_retry_at = ?
       WHERE chain_id = ?`,
    )
    .run(Date.now(), chainId)
  return result.changes
}

export function deleteCommentInboundJob(jobKey: string): void {
  getDb().prepare('DELETE FROM tg_comment_inbound_queue WHERE job_key = ?').run(jobKey)
}

export function listDueCommentInboundJobs(limit = 40): TgCommentInboundJob[] {
  return getDb()
    .prepare(
      `SELECT job_key, chain_id, discussion_chat_id, payload, attempts, last_error, created_at
       FROM tg_comment_inbound_queue
       WHERE next_retry_at <= ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(Date.now(), limit) as TgCommentInboundJob[]
}

export function listCommentInboundJobViews(limit = 80): CommentQueueJobView[] {
  const rows = getDb()
    .prepare(
      `SELECT job_key, chain_id, payload, attempts, next_retry_at, last_error, created_at
       FROM tg_comment_inbound_queue
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(limit) as Array<{
    job_key: string
    chain_id: string
    payload: string
    attempts: number
    next_retry_at: number
    last_error: string | null
    created_at: number
  }>
  return rows.map((row) => ({
    job_key: row.job_key,
    chain_id: row.chain_id,
    attempts: row.attempts,
    next_retry_at: row.next_retry_at,
    last_error: row.last_error,
    created_at: row.created_at,
    message_id: parseInboundCommentMessage(row.payload)?.message_id ?? null,
  }))
}

export function summarizeCommentQueueByChain(): Map<string, ChainQueueSummary> {
  const rows = getDb()
    .prepare(
      `SELECT chain_id, attempts, last_error, created_at
       FROM tg_comment_inbound_queue`,
    )
    .all() as Array<{ chain_id: string; attempts: number; last_error: string | null; created_at: number }>
  return summarizeQueueRows(rows)
}

export function parseInboundCommentMessage(payload: string): TgMessage | null {
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const msg = parsed as TgMessage
    if (typeof msg.message_id !== 'number' || typeof msg.chat?.id !== 'number') {
      return null
    }
    return msg
  } catch {
    return null
  }
}

