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
  staleUndeliverableCutoffIso,
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
        `${pendingCount} комментариев не синхронизированы`,
        { chainId: chain.id, pendingCount },
      )
    }
  }
}

function purgeStaleUndeliverableOnStartup(): void {
  for (const chain of listTgChainsSync()) {
    if (chain.forward_comments !== true) {
      continue
    }
    try {
      const staleCount = purgeStaleUndeliverableComments(chain.id)
      if (staleCount > 0) {
        logger.info('[maxCommentSync] purged stale undeliverable comments', {
          chainId: chain.id,
          count: staleCount,
          older_than_days: STALE_UNDELIVERABLE_DAYS,
        })
      }
    } catch (err: unknown) {
      // Не валим весь процесс: UNIQUE/прочие ошибки списывания не должны блокировать старт.
      logger.error('[maxCommentSync] stale undeliverable purge failed on startup', {
        chainId: chain.id,
        err,
      })
    }
  }
}

function purgeStaleUndeliverableDaily(): void {
  for (const chain of listTgChainsSync()) {
    if (chain.forward_comments !== true) {
      continue
    }
    try {
      const count = purgeStaleUndeliverableComments(chain.id)
      if (count > 0) {
        logger.info('[maxCommentSync] daily stale comment write-off', {
          chainId: chain.id,
          count,
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

  async function syncOnce(): Promise<void> {
    if (isTelegramApiPaused()) {
      logger.debug('[maxCommentSync] skipped: Telegram API pause active')
      return
    }

    try {
      const pendingComments = commentStore.listCommentsPendingMaxToTelegram(batchSize)
      const pendingReplies = commentStore.listCommentsPendingTelegramThreadReply(batchSize)

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
            `${pendingCount} комментариев не синхронизированы`,
            { chainId: chain.id, pendingCount },
          )
        }
      }
    } catch (err: unknown) {
      logger.error('[maxCommentSync] polling error', err)
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
