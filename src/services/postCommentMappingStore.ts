import { telegramAxios as axios } from '../utils/telegramAxios'

import { listTgChainsSync, type TgChainRecord } from '../api/adminPanelState'
import { getDb } from '../db/database'
import { logger } from '../utils/logger'
import { telegramChannelMatchesTarget } from '../utils/tgChannelMatch'
import { TtlCache } from '../utils/ttlCache'
import { pickLinkedMapping, sameMaxChat, warnOnce } from './commentLinkGuard'

const TG_API = 'https://api.telegram.org'

export interface PostCommentMappingRow {
  chain_id: string
  tg_msg_id: number
  max_mid: string
  tg_chat_id: number | null
  tg_thread_chat_id: number | null
  tg_thread_msg_id: number | null
  /** 'stale' — GetDiscussionMessage безнадёжен; 'suspect' — привязка отвергнута Telegram, refresh не удался. */
  thread_status?: 'stale' | 'suspect' | null
  thread_status_at?: number | null
}

const MAPPING_COLUMNS =
  'chain_id, tg_msg_id, max_mid, tg_chat_id, tg_thread_chat_id, tg_thread_msg_id, thread_status, thread_status_at'

/** Как долго не повторять resolve после соответствующей отметки. */
const THREAD_STALE_TTL_MS = 24 * 60 * 60_000
const THREAD_SUSPECT_TTL_MS = 10 * 60_000

/** Найденный linked chat меняется редко; «нет группы» кэшируем ненадолго — её могли привязать позже. */
const DISCUSSION_CHAT_FOUND_TTL_MS = 30 * 60_000
const DISCUSSION_CHAT_MISSING_TTL_MS = 60_000
const discussionChatCache = new TtlCache<string, number | null>()
const SKIPPED_MAX_MID = '__skipped__'
const pendingThreadLinks = new Map<string, { threadChatId: number; threadMsgId: number }>()

function pendingThreadKey(chainId: string, channelMsgId: number): string {
  return `${chainId}:${channelMsgId}`
}

function isUsableMaxMid(maxMid: string | null | undefined): maxMid is string {
  const trimmed = maxMid?.trim() ?? ''
  return trimmed.length > 0 && trimmed !== SKIPPED_MAX_MID
}

function parseTgChatIdFromPayload(payload: string | null | undefined): number | null {
  if (!payload) {
    return null
  }
  try {
    const parsed = JSON.parse(payload) as { chat?: { id?: number } }
    return typeof parsed.chat?.id === 'number' ? parsed.chat.id : null
  } catch {
    return null
  }
}

function applyPendingThreadLink(chainId: string, channelMsgId: number): void {
  const pending = pendingThreadLinks.get(pendingThreadKey(chainId, channelMsgId))
  if (!pending) {
    return
  }
  const result = getDb()
    .prepare(
      `UPDATE post_comment_mapping
       SET tg_thread_chat_id = ?, tg_thread_msg_id = ?, thread_status = NULL, thread_status_at = NULL
       WHERE chain_id = ? AND tg_msg_id = ?`,
    )
    .run(pending.threadChatId, pending.threadMsgId, chainId, channelMsgId)
  if (Number(result.changes) > 0) {
    pendingThreadLinks.delete(pendingThreadKey(chainId, channelMsgId))
  }
}

/** SQL-условие «resolve для этой строки сейчас не заблокирован статусом» (alias — псевдоним таблицы). */
function threadResolveAllowedSql(alias: string): string {
  const now = Date.now()
  return `(${alias}.thread_status IS NULL OR ${alias}.thread_status_at IS NULL OR
    ${alias}.thread_status_at <= ${now} - CASE ${alias}.thread_status
      WHEN 'stale' THEN ${THREAD_STALE_TTL_MS} ELSE ${THREAD_SUSPECT_TTL_MS} END)`
}

function threadStatusTtlMs(status: PostCommentMappingRow['thread_status']): number {
  return status === 'stale' ? THREAD_STALE_TTL_MS : THREAD_SUSPECT_TTL_MS
}

/**
 * Resolve треда временно заблокирован: недавно признан безнадёжным (stale) или отвергнут
 * Telegram без успешного refresh (suspect). По истечении TTL попытки возобновляются.
 */
export function isMappingThreadResolveStale(mapping: PostCommentMappingRow): boolean {
  const status = mapping.thread_status
  if (!status) {
    return false
  }
  const at = mapping.thread_status_at ?? 0
  return Date.now() - at < threadStatusTtlMs(status)
}

/** Привязка к треду валидна и её можно использовать для отправки. */
export function hasUsableThread(
  mapping: PostCommentMappingRow | null | undefined,
): mapping is PostCommentMappingRow & { tg_thread_chat_id: number; tg_thread_msg_id: number } {
  return Boolean(
    mapping &&
      typeof mapping.tg_thread_chat_id === 'number' &&
      mapping.tg_thread_chat_id !== 0 &&
      typeof mapping.tg_thread_msg_id === 'number' &&
      mapping.tg_thread_msg_id > 0 &&
      !isMappingThreadResolveStale(mapping),
  )
}

function setThreadStatus(
  chainId: string,
  tgMsgId: number,
  status: 'stale' | 'suspect',
): void {
  getDb()
    .prepare(
      `UPDATE post_comment_mapping
       SET thread_status = ?, thread_status_at = ?
       WHERE chain_id = ? AND tg_msg_id = ?`,
    )
    .run(status, Date.now(), chainId, tgMsgId)
}

/** GetDiscussionMessage безнадёжен (MSG_ID_INVALID для всех ключей канала). */
export function markMappingThreadResolveStale(chainId: string, tgMsgId: number): void {
  setThreadStatus(chainId, tgMsgId, 'stale')
}

/** Telegram отверг сохранённый thread id, а refresh не помог: id не трогаем, но пока не используем. */
export function markMappingThreadSuspect(chainId: string, tgMsgId: number): void {
  setThreadStatus(chainId, tgMsgId, 'suspect')
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
  applyPendingThreadLink(chainId, tgMsgId)
}

export function ensureMappingFromForwarded(
  chainId: string,
  tgMsgId: number,
): PostCommentMappingRow | null {
  const existing = findMappingByTgMsgId(chainId, tgMsgId)
  if (existing && isUsableMaxMid(existing.max_mid)) {
    return existing
  }
  const row = getDb()
    .prepare(
      `SELECT max_message_mid, tg_payload
       FROM tg_chain_forwarded
       WHERE chain_id = ? AND tg_message_id = ?`,
    )
    .get(chainId, tgMsgId) as { max_message_mid: string | null; tg_payload: string | null } | undefined
  if (!row || !isUsableMaxMid(row.max_message_mid)) {
    return null
  }
  upsertPostCommentMapping(
    chainId,
    tgMsgId,
    row.max_message_mid.trim(),
    parseTgChatIdFromPayload(row.tg_payload),
  )
  return findMappingByTgMsgId(chainId, tgMsgId)
}

export function isChannelPostSkippedForForward(chainId: string, tgMsgId: number): boolean {
  const row = getDb()
    .prepare(
      `SELECT max_message_mid
       FROM tg_chain_forwarded
       WHERE chain_id = ? AND tg_message_id = ?`,
    )
    .get(chainId, tgMsgId) as { max_message_mid: string | null } | undefined
  return row?.max_message_mid?.trim() === SKIPPED_MAX_MID
}

export function linkThreadMessageToChannelPost(
  chainId: string,
  channelMsgId: number,
  threadChatId: number,
  threadMsgId: number,
): void {
  const result = getDb()
    .prepare(
      `UPDATE post_comment_mapping
       SET tg_thread_chat_id = ?, tg_thread_msg_id = ?, thread_status = NULL, thread_status_at = NULL
       WHERE chain_id = ? AND tg_msg_id = ?`,
    )
    .run(threadChatId, threadMsgId, chainId, channelMsgId)
  if (Number(result.changes) > 0) {
    pendingThreadLinks.delete(pendingThreadKey(chainId, channelMsgId))
    return
  }
  pendingThreadLinks.set(pendingThreadKey(chainId, channelMsgId), { threadChatId, threadMsgId })
  if (ensureMappingFromForwarded(chainId, channelMsgId)) {
    applyPendingThreadLink(chainId, channelMsgId)
  }
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
  const candidates = getDb()
    .prepare(
      `SELECT chain_id, tg_message_id, tg_payload
       FROM tg_chain_forwarded
       WHERE max_message_mid = ?
       ORDER BY forwarded_at DESC`,
    )
    .all(normalized) as Array<{ chain_id: string; tg_message_id: number; tg_payload: string | null }>
  // Только связка, которая сейчас существует и ведёт в MAX-канал этого поста —
  // не «последняя по времени пересылки», иначе можно привязать пост к чужой связке.
  const chains = listTgChainsSync()
  const postChatId = lookupPostMaxChatId(normalized)
  const row =
    chains.length === 0
      ? candidates[0]
      : candidates.find((c) => {
          const chain = chains.find((x) => x.id === c.chain_id)
          return chain !== undefined && (postChatId == null || sameMaxChat(chain.max_chat_id, postChatId))
        })
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
      `SELECT m.chain_id, m.tg_msg_id, m.max_mid, m.tg_chat_id, m.tg_thread_chat_id, m.tg_thread_msg_id,
              m.thread_status, m.thread_status_at
       FROM post_comment_mapping m
       LEFT JOIN posts p ON p.message_mid = m.max_mid
       WHERE m.chain_id = ?
         AND (m.tg_thread_msg_id IS NULL OR m.tg_thread_msg_id = 0)
         AND m.tg_msg_id IS NOT NULL AND m.tg_msg_id > 0
         AND ${threadResolveAllowedSql('m')}
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

/** Id сообщений уникальны только внутри чата — при известном `threadChatId` сверяем и его. */
export function findMappingByThreadMsgId(
  chainId: string,
  threadMsgId: number,
  threadChatId?: number,
): PostCommentMappingRow | null {
  const row = getDb()
    .prepare(
      `SELECT ${MAPPING_COLUMNS}
       FROM post_comment_mapping
       WHERE chain_id = ? AND tg_thread_msg_id = ?
         AND (? IS NULL OR tg_thread_chat_id IS NULL OR tg_thread_chat_id = ?)`,
    )
    .get(chainId, threadMsgId, threadChatId ?? null, threadChatId ?? null) as
    | PostCommentMappingRow
    | undefined
  return row ?? null
}

export function findMappingByTgMsgId(
  chainId: string,
  tgMsgId: number,
): PostCommentMappingRow | null {
  const row = getDb()
    .prepare(
      `SELECT ${MAPPING_COLUMNS}
       FROM post_comment_mapping
       WHERE chain_id = ? AND tg_msg_id = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(chainId, tgMsgId) as PostCommentMappingRow | undefined
  return row ?? null
}

/** Все строки маппинга поста — без учёта связок (для диагностики и починки). Порядок: рабочий тред, затем новые. */
export function listMappingsByMaxMidRaw(maxMid: string): PostCommentMappingRow[] {
  const normalized = maxMid.trim()
  if (!normalized) {
    return []
  }
  return getDb()
    .prepare(
      `SELECT ${MAPPING_COLUMNS}
       FROM post_comment_mapping
       WHERE max_mid = ?
       ORDER BY
         (CASE WHEN tg_thread_msg_id IS NOT NULL AND tg_thread_msg_id > 0 THEN 1 ELSE 0 END) DESC,
         id DESC`,
    )
    .all(normalized) as PostCommentMappingRow[]
}

function lookupPostMaxChatId(maxMid: string): number | null {
  const row = getDb()
    .prepare('SELECT chat_id FROM posts WHERE message_mid = ? LIMIT 1')
    .get(maxMid) as { chat_id: number } | undefined
  return typeof row?.chat_id === 'number' ? row.chat_id : null
}

/**
 * Привязка поста MAX к посту/треду Telegram — только через связку этого MAX-канала.
 *
 * Один max_mid может иметь несколько строк (альбом, пересоздание связки, строки удалённых связок).
 * Берём строку живой связки, чей max_chat_id совпадает с каналом поста; строки удалённых или
 * чужих связок игнорируем, иначе комментарий мог уйти в группу обсуждения не той связки.
 * Если подходящей строки нет — null (комментарий не отправляется, см. commentLinkGuard).
 */
export function findMappingByMaxMid(maxMid: string): PostCommentMappingRow | null {
  const normalized = maxMid.trim()
  const rows = listMappingsByMaxMidRaw(normalized)
  if (rows.length === 0) {
    return null
  }
  const { mapping, rejected } = pickLinkedMapping(rows, listTgChainsSync(), lookupPostMaxChatId(normalized))
  if (!mapping) {
    warnOnce(
      `no-linked-mapping:${normalized}`,
      '[postCommentMapping] post has mappings only in deleted or foreign chains — ignored',
      { maxMid: normalized, rejected },
    )
  }
  return mapping
}

/**
 * Заполняет post_comment_mapping из tg_chain_forwarded для постов,
 * пересланных до включения синхронизации комментариев.
 */
export function backfillPostCommentMappingsFromForwarded(): number {
  const db = getDb()
  // Только для существующих связок: иначе после удаления/пересоздания связки её строки
  // tg_chain_forwarded при каждом старте воскрешали «осиротевшие» маппинги.
  const liveChainIds = new Set(listTgChainsSync().map((c) => c.id))
  const rows = (db
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
  }>).filter((r) => liveChainIds.size === 0 || liveChainIds.has(r.chain_id))

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
  const cached = discussionChatCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const channelKey = chain.tg_channel_id?.trim() || chain.tg_username?.trim().replace(/^@/, '')
  if (!channelKey) {
    discussionChatCache.set(cacheKey, null, DISCUSSION_CHAT_MISSING_TTL_MS)
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
    discussionChatCache.set(
      cacheKey,
      linked,
      linked == null ? DISCUSSION_CHAT_MISSING_TTL_MS : DISCUSSION_CHAT_FOUND_TTL_MS,
    )
    return linked
  } catch (err: unknown) {
    logger.warn('postCommentMapping: getChat linked_chat_id failed', { chainId: chain.id, err })
    return null
  }
}

export function listRecentUnmappedForwarded(
  chainId: string,
  limit = 8,
): Array<{ tgMsgId: number; maxMid: string }> {
  return getDb()
    .prepare(
      `SELECT f.tg_message_id AS tgMsgId, f.max_message_mid AS maxMid
       FROM tg_chain_forwarded f
       LEFT JOIN post_comment_mapping m
         ON m.chain_id = f.chain_id AND m.tg_msg_id = f.tg_message_id
       WHERE f.chain_id = ?
         AND f.max_message_mid IS NOT NULL
         AND TRIM(f.max_message_mid) != ''
         AND f.max_message_mid != ?
         AND (m.tg_thread_msg_id IS NULL OR m.tg_thread_msg_id = 0)
         AND (m.chain_id IS NULL OR ${threadResolveAllowedSql('m')})
       ORDER BY f.tg_message_id DESC
       LIMIT ?`,
    )
    .all(chainId, SKIPPED_MAX_MID, limit) as Array<{ tgMsgId: number; maxMid: string }>
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
