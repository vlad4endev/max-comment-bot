/**
 * maxCommentSyncService.ts
 *
 * Периодически догоняет ответы администратора из Max miniapp,
 * которые ещё не отправлены в TG discussion group.
 */

import type { Bot } from '@maxhub/max-bot-api'

import { commentStore } from './commentStore'
import { postStore } from './postStore'
import { syncAdminReplyToTelegramThread } from './telegramThreadReplySync'
import { logger } from '../utils/logger'

interface SyncOptions {
  intervalMs?: number
}

export function startMaxCommentSync(bot: Bot, options: SyncOptions = {}): () => void {
  const { intervalMs = 15_000 } = options

  async function syncOnce(): Promise<void> {
    try {
      const pending = commentStore.listCommentsPendingTelegramThreadReply(25)
      for (const comment of pending) {
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
