/**
 * maxCommentSyncService.ts
 *
 * Периодически догоняет комментарии и ответы админа из MAX miniapp,
 * которые ещё не отправлены в TG discussion group.
 */

import type { Bot } from '@maxhub/max-bot-api'

import { listTgChainsSync } from '../api/adminPanelState'
import { getDb } from '../db/database'
import { commentStore } from './commentStore'
import { postStore } from './postStore'
import {
  purgeStaleUndeliverableComments,
  STALE_UNDELIVERABLE_DAYS,
  STALE_UNDELIVERABLE_PURGE_BATCH,
} from './commentSyncDiagnostics'
import {
  syncAdminReplyToTelegramThread,
  syncMaxCommentToTelegramThread,
} from './telegramThreadReplySync'
import { ensurePostThreadMapping } from './telegramDiscussionThreadResolver'
import { findMappingByMaxMid } from './postCommentMappingStore'
import { logger } from '../utils/logger'
import { sendAdminAlert } from '../utils/alertService'
import {
  getMaxCommentSyncIntervalMs,
  getTelegramCommentSyncBatchSize,
  isTelegramApiPaused,
} from '../utils/telegramRateLimiter'

interface SyncOptions {
  intervalMs?: number
  batchSize?: number
}

const THREAD_REPAIR_PER_CYCLE = 3
const BOOTSTRAP_REPAIR_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000
const HOURLY_REPAIR_MS = 60 * 60 * 1000
const DAILY_STALE_PURGE_MS = 24 * 60 * 60 * 1000

function countPendingCommentsForChain(chainId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM comments c
       JOIN posts p ON p.post_id = c.post_id
       LEFT JOIN post_comment_mapping m ON m.max_mid = p.message_mid AND m.chain_id = ?
       WHERE (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)
         AND (c.source IS NULL OR c.source = 'max')
         AND (m.tg_thread_msg_id IS NULL OR m.tg_thread_msg_id = 0)`,
    )
    .get(chainId) as { n: number }
  return Number(row.n) || 0
}

async function repairThreadMappings(
  chainId: string,
  posts: Array<{ message_mid: string; tg_msg_id: number }>,
): Promise<void> {
  let repaired = 0
  for (const post of posts) {
    const messageMid = post.message_mid.trim()
    if (!messageMid) {
      continue
    }
    const mapping = findMappingByMaxMid(messageMid)
    if (mapping?.tg_thread_chat_id && mapping.tg_thread_msg_id) {
      continue
    }
    try {
      const result = await ensurePostThreadMapping(messageMid)
      if (result?.tg_thread_chat_id && result.tg_thread_msg_id) {
        repaired += 1
        logger.info('[maxCommentSync] bootstrap: repaired thread mapping', {
          chainId,
          messageMid,
          threadChatId: result.tg_thread_chat_id,
          threadMsgId: result.tg_thread_msg_id,
        })
      }
    } catch (err: unknown) {
      logger.warn('[maxCommentSync] bootstrap: repair thread mapping failed', {
        chainId,
        messageMid,
        err,
      })
    }
  }
  if (repaired > 0) {
    logger.info('[maxCommentSync] bootstrap: repair batch finished', {
      chainId,
      attempted: posts.length,
      repaired,
    })
  }
}

async function bootstrapRepairOnStartup(): Promise<void> {
  const db = getDb()
  const chains = listTgChainsSync().filter((c) => c.active && c.forward_comments)
  const lookbackIso = new Date(Date.now() - BOOTSTRAP_REPAIR_LOOKBACK_MS).toISOString()

  for (const chain of chains) {
    const postsNeedRepair = db
      .prepare(
        `SELECT DISTINCT p.message_mid, m.tg_msg_id
         FROM comments c
         JOIN posts p ON p.post_id = c.post_id
         JOIN post_comment_mapping m ON m.max_mid = p.message_mid AND m.chain_id = ?
         WHERE (c.tg_comment_id IS NULL OR c.tg_comment_id = 0)
           AND (c.source IS NULL OR c.source = 'max')
           AND (m.tg_thread_msg_id IS NULL OR m.tg_thread_msg_id = 0)
           AND p.timestamp > ?
         LIMIT 50`,
      )
      .all(chain.id, lookbackIso) as Array<{ message_mid: string; tg_msg_id: number }>

    if (postsNeedRepair.length > 0) {
      logger.info('[maxCommentSync] bootstrap: repairing threads for pending comments', {
        chainId: chain.id,
        count: postsNeedRepair.length,
      })
      await repairThreadMappings(chain.id, postsNeedRepair)
    }

    const pendingCount = countPendingCommentsForChain(chain.id)
    if (pendingCount > 100) {
      await sendAdminAlert(
        `comments_pending:${chain.id}`,
        `${pendingCount} комментариев не синхронизированы — перенос комментариев застопорился`,
        { chainId: chain.id, pendingCount },
      )
    }
  }
}

function purgeStaleUndeliverableOnStartup(): void {
  const chains = listTgChainsSync().filter((c) => c.forward_comments === true)
  let chainIdx = 0

  const runBatch = (): void => {
    if (chainIdx >= chains.length) {
      return
    }
    const chain = chains[chainIdx]!
    try {
      const staleCount = purgeStaleUndeliverableComments(
        chain.id,
        STALE_UNDELIVERABLE_PURGE_BATCH,
      )
      if (staleCount > 0) {
        logger.info('[maxCommentSync] purged stale undeliverable comments', {
          chainId: chain.id,
          count: staleCount,
          older_than_days: STALE_UNDELIVERABLE_DAYS,
        })
        // Ещё есть строки — следующий батч после тика event loop (HTTP/API не зависают).
        setImmediate(runBatch)
        return
      }
    } catch (err: unknown) {
      logger.error('[maxCommentSync] stale undeliverable purge failed on startup', {
        chainId: chain.id,
        err,
      })
    }
    chainIdx += 1
    setImmediate(runBatch)
  }

  setImmediate(runBatch)
}

function purgeStaleUndeliverableDaily(): void {
  for (const chain of listTgChainsSync()) {
    if (chain.forward_comments !== true) {
      continue
    }
    try {
      let total = 0
      for (let i = 0; i < 20; i += 1) {
        const count = purgeStaleUndeliverableComments(chain.id, STALE_UNDELIVERABLE_PURGE_BATCH)
        total += count
        if (count < STALE_UNDELIVERABLE_PURGE_BATCH) {
          break
        }
      }
      if (total > 0) {
        logger.info('[maxCommentSync] daily stale comment write-off', {
          chainId: chain.id,
          count: total,
          older_than_days: STALE_UNDELIVERABLE_DAYS,
        })
      }
    } catch (err: unknown) {
      logger.warn('[maxCommentSync] daily stale purge error', { chainId: chain.id, err })
    }
  }
}

export function startMaxCommentSync(bot: Bot, options: SyncOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? getMaxCommentSyncIntervalMs()
  const batchSize = options.batchSize ?? getTelegramCommentSyncBatchSize()

  // Батчи через setImmediate — не морозим event loop одним огромным UPDATE.
  purgeStaleUndeliverableOnStartup()
  void bootstrapRepairOnStartup().catch((err: unknown) => {
    logger.warn('[maxCommentSync] bootstrap repair error', { err })
  })

  const hourlyRepairTimer = setInterval(() => {
    void bootstrapRepairOnStartup().catch((err: unknown) => {
      logger.warn('[maxCommentSync] periodic repair error', { err })
    })
  }, HOURLY_REPAIR_MS)

  const dailyStaleTimer = setInterval(() => {
    try {
      purgeStaleUndeliverableDaily()
    } catch (err: unknown) {
      logger.warn('[maxCommentSync] daily stale purge error', { err })
    }
  }, DAILY_STALE_PURGE_MS)

  async function repairThreadMappingsForPending(postMessageMids: string[]): Promise<void> {
    const unique = [...new Set(postMessageMids.filter((m) => m.trim() !== ''))]
    let repaired = 0
    for (const messageMid of unique) {
      if (repaired >= THREAD_REPAIR_PER_CYCLE) {
        break
      }
      const mapping = findMappingByMaxMid(messageMid)
      if (mapping?.tg_thread_chat_id && mapping.tg_thread_msg_id) {
        continue
      }
      try {
        const result = await ensurePostThreadMapping(messageMid)
        if (result?.tg_thread_chat_id && result.tg_thread_msg_id) {
          repaired += 1
          logger.info('[maxCommentSync] auto-repaired thread mapping', {
            messageMid,
            threadChatId: result.tg_thread_chat_id,
            threadMsgId: result.tg_thread_msg_id,
          })
        }
      } catch (err: unknown) {
        logger.warn('[maxCommentSync] auto-repair thread mapping failed', { messageMid, err })
      }
    }
  }

  let syncing = false

  async function syncOnce(): Promise<void> {
    if (syncing) {
      return
    }
    if (isTelegramApiPaused()) {
      logger.debug('[maxCommentSync] skipped: Telegram API pause active')
      return
    }

    syncing = true
    try {
      const chains = listTgChainsSync().filter((c) => c.active && c.forward_comments)
      const perChain = Math.max(3, Math.ceil(batchSize / Math.max(chains.length, 1)))

      const pendingComments: ReturnType<typeof commentStore.listCommentsPendingMaxToTelegram> = []
      const pendingReplies: typeof pendingComments = []
      const seenCommentIds = new Set<string>()
      const seenReplyIds = new Set<string>()
      for (const chain of chains) {
        const chatId = chain.max_chat_id
        for (const comment of commentStore.listCommentsPendingMaxToTelegramForChat(chatId, perChain)) {
          if (seenCommentIds.has(comment.comment_id)) continue
          seenCommentIds.add(comment.comment_id)
          pendingComments.push(comment)
        }
        for (const comment of commentStore.listCommentsPendingTelegramThreadReplyForChat(chatId, perChain)) {
          if (seenReplyIds.has(comment.comment_id)) continue
          seenReplyIds.add(comment.comment_id)
          pendingReplies.push(comment)
        }
      }

      if (pendingComments.length === 0 && pendingReplies.length === 0 && chains.length === 0) {
        const fallbackComments = commentStore.listCommentsPendingMaxToTelegram(batchSize)
        const fallbackReplies = commentStore.listCommentsPendingTelegramThreadReply(batchSize)
        pendingComments.push(...fallbackComments)
        pendingReplies.push(...fallbackReplies)
      }

      const messageMids: string[] = []
      for (const comment of [...pendingComments, ...pendingReplies]) {
        const post = postStore.getPost(comment.post_id)
        if (post?.message_mid) {
          messageMids.push(post.message_mid)
        }
      }
      if (messageMids.length > 0) {
        await repairThreadMappingsForPending(messageMids)
      }

      for (const comment of pendingComments) {
        if (isTelegramApiPaused()) {
          break
        }
        const post = postStore.getPost(comment.post_id)
        if (!post) {
          continue
        }
        await syncMaxCommentToTelegramThread(bot, comment, post)
      }

      for (const comment of pendingReplies) {
        if (isTelegramApiPaused()) {
          break
        }
        const post = postStore.getPost(comment.post_id)
        if (!post) {
          continue
        }
        await syncAdminReplyToTelegramThread(bot, comment, post)
      }

      for (const chain of listTgChainsSync()) {
        if (!chain.active || !chain.forward_comments) {
          continue
        }
        const pendingCount = countPendingCommentsForChain(chain.id)
        if (pendingCount > 100) {
          await sendAdminAlert(
            `comments_pending:${chain.id}`,
            `${pendingCount} комментариев не синхронизированы — перенос комментариев застопорился`,
            { chainId: chain.id, pendingCount },
          )
        }
      }
    } catch (err: unknown) {
      logger.error('[maxCommentSync] polling error', err)
      void sendAdminAlert(
        'comment_sync_loop',
        'Сбой синхронизации комментариев MAX→Telegram — перенос комментариев может быть остановлен',
        { error: err instanceof Error ? err.message : String(err) },
      )
    } finally {
      syncing = false
    }
  }

  const timer = setInterval(() => {
    void syncOnce()
  }, intervalMs)
  void syncOnce()

  logger.info('[maxCommentSync] started', { intervalMs, batchSize })

  return () => {
    clearInterval(timer)
    clearInterval(hourlyRepairTimer)
    clearInterval(dailyStaleTimer)
  }
}
