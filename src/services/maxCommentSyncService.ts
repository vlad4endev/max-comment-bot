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
import { logger } from '../utils/logger'

interface SyncOptions {
  intervalMs?: number
}

export function startMaxCommentSync(bot: Bot, options: SyncOptions = {}): () => void {
  const { intervalMs = 15_000 } = options

  async function syncOnce(): Promise<void> {
    try {
      const pendingComments = commentStore.listCommentsPendingMaxToTelegram(25)
      for (const comment of pendingComments) {
        const post = postStore.getPost(comment.post_id)
        if (!post) {
          continue
        }
        await syncMaxCommentToTelegramThread(bot, comment, post)
      }

      const pendingReplies = commentStore.listCommentsPendingTelegramThreadReply(25)
      for (const comment of pendingReplies) {
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

  return () => clearInterval(timer)
}
