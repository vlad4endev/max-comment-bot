/**
 * maxCommentSyncService.ts
 *
 * Периодически догоняет комментарии и ответы админа из MAX miniapp,
 * которые ещё не отправлены в TG discussion group.
 */

import type { Bot } from '@maxhub/max-bot-api'

import { commentStore } from './commentStore'
import { postStore } from './postStore'
import {
  syncAdminReplyToTelegramThread,
  syncMaxCommentToTelegramThread,
} from './telegramThreadReplySync'
import { ensurePostThreadMapping } from './telegramDiscussionThreadResolver'
import { findMappingByMaxMid } from './postCommentMappingStore'
import { logger } from '../utils/logger'
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

export function startMaxCommentSync(bot: Bot, options: SyncOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? getMaxCommentSyncIntervalMs()
  const batchSize = options.batchSize ?? getTelegramCommentSyncBatchSize()

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
    } catch (err: unknown) {
      logger.error('[maxCommentSync] polling error', err)
    }
  }

  const timer = setInterval(() => {
    void syncOnce()
  }, intervalMs)
  void syncOnce()

  logger.info('[maxCommentSync] started', { intervalMs, batchSize })

  return () => clearInterval(timer)
}
