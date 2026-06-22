import type { Bot } from '@maxhub/max-bot-api'
import type { Message } from '@maxhub/max-bot-api/types'

import { listTgChainsSync, type TgChainRecord } from '../api/adminPanelState'
import { getDb } from '../db/database'
import { fetchChannelMessagesSince } from './channelPoller'
import { commentStore } from './commentStore'
import { postStore } from './postStore'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { logger } from '../utils/logger'
import { apiCallWithRetry } from '../utils/maxApiRetry'

const DELETE_INTERVAL_MS = 600

export type PurgeMaxPostsSource = 'auto' | 'forwarded' | 'posts_db' | 'feed'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface PurgeTgChainMaxPostsOptions {
  /** ISO — удалять посты, опубликованные не раньше этой даты. По умолчанию created_at связки. */
  sinceIso?: string
  /** ISO — верхняя граница (не включительно). */
  untilIso?: string
  dryRun?: boolean
  limit?: number
  /** auto: forwarded → posts_db → feed */
  source?: PurgeMaxPostsSource
}

export interface PurgeTgChainMaxPostsResult {
  chain_id: string
  max_chat_id: number
  since: string
  until: string | null
  source_used: 'forwarded' | 'posts_db' | 'feed' | 'none'
  scanned_mids: number
  deleted: number
  failed: number
  dry_run: boolean
  sample_mids: string[]
}

function findTgChain(chainId: string): TgChainRecord | null {
  return listTgChainsSync().find((c) => c.id === chainId) ?? null
}

function messageTimestampMs(message: Message): number {
  const ts = message.timestamp
  return ts > 1e12 ? ts : ts * 1000
}

async function deleteMaxMessage(bot: Bot, messageMid: string): Promise<boolean> {
  try {
    await apiCallWithRetry(() => bot.api.deleteMessage(messageMid))
    return true
  } catch (err: unknown) {
    logger.warn('[tgChainPurge] deleteMessage failed', { messageMid, err })
    return false
  }
}

function listForwardedMaxMids(
  chainId: string,
  sinceIso: string,
  untilIso: string | null,
  limit: number,
): string[] {
  const params: Array<string | number> = [chainId, sinceIso]
  let sql = `
    SELECT DISTINCT TRIM(max_message_mid) AS mid
    FROM tg_chain_forwarded
    WHERE chain_id = ?
      AND max_message_mid IS NOT NULL
      AND TRIM(max_message_mid) != ''
      AND forwarded_at >= ?
  `
  if (untilIso) {
    sql += ' AND forwarded_at < ?'
    params.push(untilIso)
  }
  sql += ' ORDER BY forwarded_at ASC LIMIT ?'
  params.push(limit)

  const rows = getDb().prepare(sql).all(...params) as Array<{ mid: string }>
  return rows.map((r) => r.mid.trim()).filter((m) => m !== '')
}

function listPostsDbMids(
  chatId: number,
  sinceIso: string,
  untilIso: string | null,
  limit: number,
): string[] {
  const canonical = resolveCanonicalChannelChatId(chatId) ?? chatId
  const abs = Math.abs(canonical)
  const params: Array<string | number> = [canonical, chatId, abs, sinceIso]
  let sql = `
    SELECT message_mid, comments_ui_message_mid
    FROM posts
    WHERE (chat_id = ? OR chat_id = ? OR ABS(chat_id) = ?)
      AND created_at >= ?
  `
  if (untilIso) {
    sql += ' AND created_at < ?'
    params.push(untilIso)
  }
  sql += ' ORDER BY created_at ASC LIMIT ?'
  params.push(limit)

  const rows = getDb().prepare(sql).all(...params) as Array<{
    message_mid: string
    comments_ui_message_mid: string | null
  }>
  const mids = new Set<string>()
  for (const row of rows) {
    const main = row.message_mid?.trim()
    if (main) {
      mids.add(main)
    }
    const ui = row.comments_ui_message_mid?.trim()
    if (ui) {
      mids.add(ui)
    }
  }
  return [...mids]
}

async function listFeedMids(
  bot: Bot,
  chatId: number,
  sinceIso: string,
  untilIso: string | null,
  limit: number,
): Promise<string[]> {
  const sinceMs = Date.parse(sinceIso)
  if (!Number.isFinite(sinceMs)) {
    return []
  }
  const untilMs = untilIso ? Date.parse(untilIso) : null

  const canonical = resolveCanonicalChannelChatId(chatId) ?? chatId
  const messages = await fetchChannelMessagesSince(bot, canonical, sinceMs, {
    maxPages: 100,
    pageSize: 100,
  })

  const mids: string[] = []
  for (const message of messages) {
    const at = messageTimestampMs(message)
    if (untilMs !== null && Number.isFinite(untilMs) && at >= untilMs) {
      continue
    }
    const mid = message.body?.mid?.trim()
    if (mid) {
      mids.push(mid)
    }
    if (mids.length >= limit) {
      break
    }
  }
  return mids
}

async function resolvePurgeMids(
  bot: Bot,
  chain: TgChainRecord,
  sinceIso: string,
  untilIso: string | null,
  limit: number,
  source: PurgeMaxPostsSource,
): Promise<{ mids: string[]; sourceUsed: PurgeTgChainMaxPostsResult['source_used'] }> {
  if (source === 'forwarded' || source === 'auto') {
    const forwarded = listForwardedMaxMids(chain.id, sinceIso, untilIso, limit)
    if (forwarded.length > 0 || source === 'forwarded') {
      return { mids: forwarded, sourceUsed: forwarded.length > 0 ? 'forwarded' : 'none' }
    }
  }

  if (source === 'posts_db' || source === 'auto') {
    const fromDb = listPostsDbMids(chain.max_chat_id, sinceIso, untilIso, limit)
    if (fromDb.length > 0 || source === 'posts_db') {
      return { mids: fromDb, sourceUsed: fromDb.length > 0 ? 'posts_db' : 'none' }
    }
  }

  if (source === 'feed' || source === 'auto') {
    const fromFeed = await listFeedMids(bot, chain.max_chat_id, sinceIso, untilIso, limit)
    return { mids: fromFeed, sourceUsed: fromFeed.length > 0 ? 'feed' : 'none' }
  }

  return { mids: [], sourceUsed: 'none' }
}

/**
 * Удаляет из MAX посты связки: сначала tg_chain_forwarded, иначе posts SQLite, иначе лента канала.
 */
export async function purgeTgChainForwardedMaxPosts(
  bot: Bot,
  chainId: string,
  options?: PurgeTgChainMaxPostsOptions,
): Promise<PurgeTgChainMaxPostsResult> {
  const chain = findTgChain(chainId)
  if (!chain) {
    throw new Error('chain_not_found')
  }

  const since =
    options?.sinceIso?.trim() ||
    chain.forward_posts_since?.trim() ||
    chain.created_at?.trim() ||
    new Date(0).toISOString()
  const until = options?.untilIso?.trim() || null
  const limit = Math.max(1, Math.min(2000, Math.floor(options?.limit ?? 500)))
  const dryRun = options?.dryRun === true
  const source: PurgeMaxPostsSource = options?.source ?? 'auto'

  const { mids, sourceUsed } = await resolvePurgeMids(bot, chain, since, until, limit, source)
  const result: PurgeTgChainMaxPostsResult = {
    chain_id: chain.id,
    max_chat_id: chain.max_chat_id,
    since,
    until,
    source_used: sourceUsed,
    scanned_mids: mids.length,
    deleted: 0,
    failed: 0,
    dry_run: dryRun,
    sample_mids: mids.slice(0, 10),
  }

  if (dryRun || mids.length === 0) {
    return result
  }

  const deleteMapping = getDb().prepare(
    `DELETE FROM post_comment_mapping WHERE chain_id = ? AND max_mid = ?`,
  )

  for (const mid of mids) {
    const post =
      postStore.findPostByChannelMessage(chain.max_chat_id, mid) ??
      postStore.findByMessageMid(mid)

    const midsToDelete = new Set<string>([mid])
    if (post?.comments_ui_message_mid?.trim()) {
      midsToDelete.add(post.comments_ui_message_mid.trim())
    }
    if (post?.message_mid?.trim()) {
      midsToDelete.add(post.message_mid.trim())
    }

    if (post) {
      commentStore.removeCommentsByPostIds(new Set([post.post_id]))
      postStore.deletePostById(post.post_id)
    }

    deleteMapping.run(chain.id, mid)

    let ok = true
    for (const m of midsToDelete) {
      const deleted = await deleteMaxMessage(bot, m)
      if (!deleted) {
        ok = false
      }
      await sleep(DELETE_INTERVAL_MS)
    }

    if (ok) {
      result.deleted += 1
    } else {
      result.failed += 1
    }
  }

  logger.info('[tgChainPurge] purge completed', result)
  return result
}
