import type { Bot } from '@maxhub/max-bot-api'

import { listTgChainsSync, type TgChainRecord } from '../api/adminPanelState'
import { getDb } from '../db/database'
import { commentStore } from './commentStore'
import { postStore } from './postStore'
import { logger } from '../utils/logger'
import { apiCallWithRetry } from '../utils/maxApiRetry'

const DELETE_INTERVAL_MS = 600

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface PurgeTgChainMaxPostsOptions {
  /** ISO — удалять посты, пересланные не раньше этой даты. По умолчанию created_at связки. */
  sinceIso?: string
  /** ISO — верхняя граница forwarded_at (не включительно). */
  untilIso?: string
  dryRun?: boolean
  limit?: number
}

export interface PurgeTgChainMaxPostsResult {
  chain_id: string
  max_chat_id: number
  since: string
  until: string | null
  scanned_mids: number
  deleted: number
  failed: number
  dry_run: boolean
  sample_mids: string[]
}

function findTgChain(chainId: string): TgChainRecord | null {
  return listTgChainsSync().find((c) => c.id === chainId) ?? null
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

/**
 * Удаляет из MAX посты, созданные пересылкой TG→MAX для связки (по tg_chain_forwarded).
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

  const mids = listForwardedMaxMids(chain.id, since, until, limit)
  const result: PurgeTgChainMaxPostsResult = {
    chain_id: chain.id,
    max_chat_id: chain.max_chat_id,
    since,
    until,
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
