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
}

const MAX_RETRY_DELAY_MS = 5 * 60_000

export function retryDelayMs(attempts: number): number {
  const exp = Math.min(Math.max(attempts, 0), 8)
  return Math.min(2_000 * 2 ** exp, MAX_RETRY_DELAY_MS)
}

export function upsertForwardQueueJob(input: {
  jobKey: string
  chainId: string
  tgToken: string
  messages: TgMessage[]
  nextRetryAt: number
}): void {
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
      JSON.stringify(input.messages),
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
      `SELECT job_key, chain_id, tg_token, payload, attempts, next_retry_at, last_error
       FROM tg_chain_forward_queue
       WHERE next_retry_at <= ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(Date.now(), limit) as TgChainForwardQueueJob[]
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

export function bumpCommentInboundRetry(jobKey: string, err: unknown): number {
  const row = getDb()
    .prepare('SELECT attempts FROM tg_comment_inbound_queue WHERE job_key = ?')
    .get(jobKey) as { attempts: number } | undefined
  const attempts = (row?.attempts ?? 0) + 1
  const lastError = err instanceof Error ? err.message.slice(0, 500) : String(err ?? 'retry').slice(0, 500)
  getDb()
    .prepare(
      `UPDATE tg_comment_inbound_queue
       SET attempts = ?, next_retry_at = ?, last_error = ?
       WHERE job_key = ?`,
    )
    .run(attempts, Date.now() + retryDelayMs(attempts), lastError, jobKey)
  return attempts
}

export function deleteCommentInboundJob(jobKey: string): void {
  getDb().prepare('DELETE FROM tg_comment_inbound_queue WHERE job_key = ?').run(jobKey)
}

export function listDueCommentInboundJobs(limit = 40): TgCommentInboundJob[] {
  return getDb()
    .prepare(
      `SELECT job_key, chain_id, discussion_chat_id, payload, attempts
       FROM tg_comment_inbound_queue
       WHERE next_retry_at <= ?
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(Date.now(), limit) as TgCommentInboundJob[]
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

