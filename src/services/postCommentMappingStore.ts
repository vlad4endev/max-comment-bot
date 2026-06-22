import axios from 'axios'

import { listTgChainsSync, type TgChainRecord } from '../api/adminPanelState'
import { getDb } from '../db/database'
import { logger } from '../utils/logger'
import { telegramChannelMatchesTarget } from '../utils/tgChannelMatch'

const TG_API = 'https://api.telegram.org'

export interface PostCommentMappingRow {
  chain_id: string
  tg_msg_id: number
  max_mid: string
  tg_chat_id: number | null
  tg_thread_chat_id: number | null
  tg_thread_msg_id: number | null
}

const discussionChatCache = new Map<string, number | null>()

/** Маркер в tg_thread_msg_id: GetDiscussionMessage безнадёжен, repair пропускает. */
export const STALE_THREAD_MSG_ID = -1

export function isMappingThreadResolveStale(mapping: PostCommentMappingRow): boolean {
  return mapping.tg_thread_msg_id === STALE_THREAD_MSG_ID
}

export function markMappingThreadResolveStale(chainId: string, tgMsgId: number): void {
  getDb()
    .prepare(
      `UPDATE post_comment_mapping
       SET tg_thread_msg_id = ?
       WHERE chain_id = ? AND tg_msg_id = ?`,
    )
    .run(STALE_THREAD_MSG_ID, chainId, tgMsgId)
}

export function transferPostCommentMappingsChainId(oldChainId: string, newChainId: string): number {
  const result = getDb()
    .prepare(`UPDATE post_comment_mapping SET chain_id = ? WHERE chain_id = ?`)
    .run(newChainId, oldChainId)
  return Number(result.changes) || 0
}

export function countPendingMaxCommentsForMaxMid(maxMid: string): number {
  const normalized = maxMid.trim()
  if (!normalized) {
    return 0
  }
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n
       FROM comments c
       INNER JOIN posts p ON p.post_id = c.post_id
       WHERE p.message_mid = ?
         AND (c.source IS NULL OR c.source = 'max')
         AND (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)`,
    )
    .get(normalized) as { n: number }
  return Number(row.n) || 0
}

/** Ключ TG-канала для API: предпочитаем tg_chat_id из маппинга (фактический источник поста). */
export function resolveTelegramChannelKeyForMapping(
  mapping: PostCommentMappingRow,
  chain?: TgChainRecord | null,
): string | null {
  if (typeof mapping.tg_chat_id === 'number') {
    return String(mapping.tg_chat_id)
  }
  const resolvedChain = chain ?? listTgChainsSync().find((c) => c.id === mapping.chain_id)
  const fromChainId = resolvedChain?.tg_channel_id?.trim()
  if (fromChainId) {
    return fromChainId
  }
  const username = resolvedChain?.tg_username?.trim()
  if (username) {
    return username.startsWith('@') ? username : `@${username}`
  }
  return null
}

/** Уникальные ключи канала для GetDiscussionMessage (peer = канал, не discussion group). */
export function listTelegramChannelKeyCandidatesForMapping(
  mapping: PostCommentMappingRow,
  chain?: TgChainRecord | null,
  discussionChatId?: number | null,
): string[] {
  const resolvedChain = chain ?? listTgChainsSync().find((c) => c.id === mapping.chain_id)
  const keys: string[] = []
  const seen = new Set<string>()

  const push = (key: string | null | undefined): void => {
    const trimmed = key?.trim()
    if (!trimmed || seen.has(trimmed)) {
      return
    }
    if (discussionChatId != null && trimmed === String(discussionChatId)) {
      return
    }
    if (typeof mapping.tg_thread_chat_id === 'number' && trimmed === String(mapping.tg_thread_chat_id)) {
      return
    }
    seen.add(trimmed)
    keys.push(trimmed)
  }

  push(resolvedChain?.tg_channel_id)
  const username = resolvedChain?.tg_username?.trim()
  if (username) {
    push(username.startsWith('@') ? username : `@${username}`)
  }
  if (typeof mapping.tg_chat_id === 'number') {
    push(String(mapping.tg_chat_id))
  }

  return keys
}

export function countMappingChannelIdMismatch(chainId: string): number {
  const chain = listTgChainsSync().find((c) => c.id === chainId)
  if (!chain) {
    return 0
  }
  const chainKeys = [
    chain.tg_channel_id?.trim(),
    chain.tg_username?.trim() ? `@${chain.tg_username.trim().replace(/^@/, '')}` : null,
  ].filter(Boolean) as string[]
  if (chainKeys.length === 0) {
    return 0
  }

  const rows = getDb()
    .prepare(
      `SELECT tg_chat_id
       FROM post_comment_mapping
       WHERE chain_id = ?
         AND tg_chat_id IS NOT NULL`,
    )
    .all(chainId) as Array<{ tg_chat_id: number }>

  let mismatched = 0
  for (const row of rows) {
    const chat = { id: row.tg_chat_id }
    if (!chainKeys.some((key) => telegramChannelMatchesTarget(chat, key))) {
      mismatched += 1
    }
  }
  return mismatched
}

export function upsertPostCommentMapping(
  chainId: string,
  tgMsgId: number,
  maxMid: string,
  tgChatId: number | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO post_comment_mapping (chain_id, tg_msg_id, max_mid, tg_chat_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chain_id, tg_msg_id) DO UPDATE SET
         max_mid    = excluded.max_mid,
         tg_chat_id = excluded.tg_chat_id`,
    )
    .run(chainId, tgMsgId, maxMid, tgChatId)
}

export function linkThreadMessageToChannelPost(
  chainId: string,
  channelMsgId: number,
  threadChatId: number,
  threadMsgId: number,
): void {
  getDb()
    .prepare(
      `UPDATE post_comment_mapping
       SET tg_thread_chat_id = ?, tg_thread_msg_id = ?
       WHERE chain_id = ? AND tg_msg_id = ?`,
    )
    .run(threadChatId, threadMsgId, chainId, channelMsgId)
}

/** Сбрасывает устаревший thread id — для повторного resolve через GetDiscussionMessage. */
export function clearPostThreadMapping(chainId: string, tgMsgId: number): void {
  getDb()
    .prepare(
      `UPDATE post_comment_mapping
       SET tg_thread_chat_id = NULL, tg_thread_msg_id = NULL
       WHERE chain_id = ? AND tg_msg_id = ?`,
    )
    .run(chainId, tgMsgId)
}

/** Удаляет битый маппинг (MSG_ID_INVALID / удалённый пост в TG). */
export function deletePostCommentMapping(chainId: string, tgMsgId: number): boolean {
  const result = getDb()
    .prepare(`DELETE FROM post_comment_mapping WHERE chain_id = ? AND tg_msg_id = ?`)
    .run(chainId, tgMsgId)
  return Number(result.changes) > 0
}

/** Пересоздаёт маппинг для max_mid из tg_chain_forwarded (последняя пересылка). */
export function backfillPostCommentMappingForMaxMid(maxMid: string): boolean {
  const normalized = maxMid.trim()
  if (!normalized) {
    return false
  }
  const row = getDb()
    .prepare(
      `SELECT chain_id, tg_message_id, tg_payload
       FROM tg_chain_forwarded
       WHERE max_message_mid = ?
       ORDER BY forwarded_at DESC
       LIMIT 1`,
    )
    .get(normalized) as
    | { chain_id: string; tg_message_id: number; tg_payload: string | null }
    | undefined
  if (!row) {
    return false
  }
  let tgChatId: number | null = null
  if (row.tg_payload) {
    try {
      const parsed = JSON.parse(row.tg_payload) as { chat?: { id?: number } }
      if (typeof parsed.chat?.id === 'number') {
        tgChatId = parsed.chat.id
      }
    } catch {
      // ignore
    }
  }
  upsertPostCommentMapping(row.chain_id, row.tg_message_id, normalized, tgChatId)
  return true
}

export interface PostMappingThreadStats {
  total: number
  with_thread: number
  missing_thread: number
}

export function countPostMappingThreadStats(chainId?: string): PostMappingThreadStats {
  const where = chainId ? 'WHERE chain_id = ?' : ''
  const params = chainId ? [chainId] : []
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN tg_thread_msg_id IS NOT NULL AND tg_thread_msg_id > 0 THEN 1 ELSE 0 END) AS with_thread,
         SUM(CASE WHEN tg_thread_msg_id IS NULL OR tg_thread_msg_id = 0 THEN 1 ELSE 0 END) AS missing_thread
       FROM post_comment_mapping
       ${where}`,
    )
    .get(...params) as { total: number; with_thread: number; missing_thread: number }
  return {
    total: Number(row.total) || 0,
    with_thread: Number(row.with_thread) || 0,
    missing_thread: Number(row.missing_thread) || 0,
  }
}

export function listMappingsMissingThread(
  chainId: string,
  limit = 50,
  options?: { onlyWithPending?: boolean },
): PostCommentMappingRow[] {
  const safeLimit = Math.min(Math.max(limit, 1), 200)
  const pendingFilter = options?.onlyWithPending
    ? `AND (
         SELECT COUNT(*) FROM comments c
         WHERE c.post_id = p.post_id
           AND (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)
           AND (c.source IS NULL OR c.source = 'max')
       ) > 0`
    : ''
  return getDb()
    .prepare(
      `SELECT m.chain_id, m.tg_msg_id, m.max_mid, m.tg_chat_id, m.tg_thread_chat_id, m.tg_thread_msg_id
       FROM post_comment_mapping m
       LEFT JOIN posts p ON p.message_mid = m.max_mid
       WHERE m.chain_id = ?
         AND (m.tg_thread_msg_id IS NULL OR m.tg_thread_msg_id = 0)
         AND m.tg_msg_id IS NOT NULL AND m.tg_msg_id > 0
         ${pendingFilter}
       ORDER BY
         (SELECT COUNT(*) FROM comments c
          WHERE c.post_id = p.post_id
            AND (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)
            AND (c.source IS NULL OR c.source = 'max')
         ) DESC,
         p.timestamp DESC
       LIMIT ?`,
    )
    .all(chainId, safeLimit) as PostCommentMappingRow[]
}

export function findMappingByThreadMsgId(
  chainId: string,
  threadMsgId: number,
): PostCommentMappingRow | null {
  const row = getDb()
    .prepare(
      `SELECT chain_id, tg_msg_id, max_mid, tg_chat_id, tg_thread_chat_id, tg_thread_msg_id
       FROM post_comment_mapping
       WHERE chain_id = ? AND tg_thread_msg_id = ?`,
    )
    .get(chainId, threadMsgId) as PostCommentMappingRow | undefined
  return row ?? null
}

export function findMappingByTgMsgId(
  chainId: string,
  tgMsgId: number,
): PostCommentMappingRow | null {
  const row = getDb()
    .prepare(
      `SELECT chain_id, tg_msg_id, max_mid, tg_chat_id, tg_thread_chat_id, tg_thread_msg_id
       FROM post_comment_mapping
       WHERE chain_id = ? AND tg_msg_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(chainId, tgMsgId) as PostCommentMappingRow | undefined
  return row ?? null
}

export function findMappingByMaxMid(maxMid: string): PostCommentMappingRow | null {
  const normalized = maxMid.trim()
  if (!normalized) {
    return null
  }
  // Один max_mid может иметь несколько tg_msg_id (редактирование/альбом).
  // Предпочитаем строку с заполненным thread id — иначе sync ломается на «битой» последней записи.
  const row = getDb()
    .prepare(
      `SELECT chain_id, tg_msg_id, max_mid, tg_chat_id, tg_thread_chat_id, tg_thread_msg_id
       FROM post_comment_mapping
       WHERE max_mid = ?
       ORDER BY
         (CASE WHEN tg_thread_msg_id IS NOT NULL AND tg_thread_msg_id > 0 THEN 1 ELSE 0 END) DESC,
         id DESC
       LIMIT 1`,
    )
    .get(normalized) as PostCommentMappingRow | undefined
  return row ?? null
}

/**
 * Заполняет post_comment_mapping из tg_chain_forwarded для постов,
 * пересланных до включения синхронизации комментариев.
 */
export function backfillPostCommentMappingsFromForwarded(): number {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT chain_id, tg_message_id, max_message_mid, tg_payload
       FROM tg_chain_forwarded
       WHERE max_message_mid IS NOT NULL AND TRIM(max_message_mid) != ''`,
    )
    .all() as Array<{
    chain_id: string
    tg_message_id: number
    max_message_mid: string
    tg_payload: string | null
  }>

  const insert = db.prepare(
    `INSERT INTO post_comment_mapping (chain_id, tg_msg_id, max_mid, tg_chat_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chain_id, tg_msg_id) DO NOTHING`,
  )

  let inserted = 0
  for (const row of rows) {
    let tgChatId: number | null = null
    if (row.tg_payload) {
      try {
        const parsed = JSON.parse(row.tg_payload) as { chat?: { id?: number } }
        if (typeof parsed.chat?.id === 'number') {
          tgChatId = parsed.chat.id
        }
      } catch {
        // ignore corrupt payload
      }
    }
    const result = insert.run(
      row.chain_id,
      row.tg_message_id,
      row.max_message_mid.trim(),
      tgChatId,
    )
    inserted += Number(result.changes) || 0
  }

  if (inserted > 0) {
    logger.info('[postCommentMapping] backfilled mappings from tg_chain_forwarded', {
      inserted,
    })
  }
  return inserted
}

export async function resolveDiscussionChatId(
  tgToken: string,
  chain: TgChainRecord,
): Promise<number | null> {
  const manual = chain.tg_discussion_chat_id?.trim()
  if (manual && /^-?\d+$/.test(manual)) {
    return Number(manual)
  }

  const cacheKey = `${chain.id}:${tgToken}`
  if (discussionChatCache.has(cacheKey)) {
    return discussionChatCache.get(cacheKey) ?? null
  }

  const channelKey = chain.tg_channel_id?.trim() || chain.tg_username?.trim().replace(/^@/, '')
  if (!channelKey) {
    discussionChatCache.set(cacheKey, null)
    return null
  }

  const chatId = /^-?\d+$/.test(channelKey)
    ? channelKey
    : `@${channelKey.replace(/^@/, '')}`

  try {
    const { data } = await axios.get<{
      ok: boolean
      result?: { linked_chat_id?: number }
    }>(`${TG_API}/bot${tgToken}/getChat`, {
      params: { chat_id: chatId },
      timeout: 15_000,
    })
    const linked =
      data.ok && typeof data.result?.linked_chat_id === 'number'
        ? data.result.linked_chat_id
        : null
    discussionChatCache.set(cacheKey, linked)
    return linked
  } catch (err: unknown) {
    logger.warn('postCommentMapping: getChat linked_chat_id failed', { chainId: chain.id, err })
    discussionChatCache.set(cacheKey, null)
    return null
  }
}

/**
 * Раньше проставлял tg_thread_chat_id без tg_thread_msg_id — из-за этого
 * findMappingByMaxMid выбирал «битую» строку. Thread id задаётся через
 * handleDiscussionAutoForward / ensurePostThreadMapping.
 */
export async function storeDiscussionChatIdForChain(
  _tgToken: string,
  _chain: TgChainRecord,
): Promise<void> {
  // no-op
}
