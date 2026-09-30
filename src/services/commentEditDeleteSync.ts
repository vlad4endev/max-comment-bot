/**
 * commentEditDeleteSync.ts
 *
 * Правки и удаления комментариев Telegram → MAX (комментарий уже перенесён в miniapp).
 * Обратное направление (MAX → Telegram) — в telegramThreadReplySync.ts.
 */

import type { Bot } from '@maxhub/max-bot-api'

import type { TgChainRecord } from '../api/adminPanelState'
import type { TgMessage } from '../forwarder/telegramReader'
import {
  TG_BOOKED_IN_MAX_MARKER,
  TG_BOOKED_IN_VK_MARKER,
  isMaxAdminReplyInTelegram,
  isMaxCommentInTelegram,
  isTelegramCommentMarkedAnsweredInMax,
} from '../utils/commentSyncFilter'
import { logger } from '../utils/logger'
import { commentStore } from './commentStore'
import { postStore } from './postStore'
import { syncTelegramAdminCommentNotification } from './telegramAdminNotificationService'
import { updateCommentInboundJobPayload } from './tgChainForwardQueue'

export type TgCommentEditResult = 'updated' | 'queued' | 'ignored'

/** Служебные тексты, которые мы сами дописываем в сообщения Telegram — не считаем пользовательской правкой. */
function isServiceText(text: string): boolean {
  return (
    isMaxAdminReplyInTelegram(text) ||
    isMaxCommentInTelegram(text) ||
    isTelegramCommentMarkedAnsweredInMax(text) ||
    text.includes(TG_BOOKED_IN_MAX_MARKER) ||
    text.includes(TG_BOOKED_IN_VK_MARKER)
  )
}

/**
 * Правка комментария в discussion group → правка комментария в miniapp.
 * Если комментарий ещё в очереди переноса — обновляем сообщение в очереди.
 */
export async function handleTgCommentEdited(
  message: TgMessage,
  chain: TgChainRecord,
  discussionChatId: number,
): Promise<TgCommentEditResult> {
  const text = (message.text || message.caption || '').trim()
  if (!text || isServiceText(text)) {
    return 'ignored'
  }

  const comment = commentStore.findCommentByTgMessage(discussionChatId, message.message_id)
  if (!comment) {
    const queued = updateCommentInboundJobPayload(`${chain.id}:${message.message_id}`, message)
    return queued ? 'queued' : 'ignored'
  }

  // Копии комментариев из MAX в Telegram правит только MAX; VK сюда не попадает.
  if (comment.source !== 'telegram' || comment.text.trim() === text) {
    return 'ignored'
  }

  const updated = commentStore.updateCommentText(comment.comment_id, text)
  if (!updated) {
    return 'ignored'
  }

  const post = postStore.getPost(updated.post_id)
  if (post) {
    try {
      await syncTelegramAdminCommentNotification({
        comment: updated,
        postId: post.post_id,
        channelChatId: post.chat_id,
        messageMid: post.message_mid,
      })
    } catch (err: unknown) {
      logger.warn('[commentEditSync] TG admin notification refresh failed', {
        commentId: updated.comment_id,
        err,
      })
    }
  }

  logger.info('[commentEditSync] TG comment edit synced to MAX', {
    chainId: chain.id,
    tgCommentId: message.message_id,
    commentId: updated.comment_id,
  })
  return 'updated'
}

/**
 * Удаление комментариев в discussion group → удаление их копий в miniapp.
 * Удаляем только комментарии Telegram-происхождения; копии из MAX остаются в MAX.
 * @returns id удалённых в MAX комментариев
 */
export async function handleTgCommentsDeleted(
  discussionChatId: number,
  tgMessageIds: number[],
  bot: Bot | null,
): Promise<string[]> {
  const removedIds: string[] = []
  for (const tgMessageId of tgMessageIds) {
    const comment = commentStore.findCommentByTgMessage(discussionChatId, tgMessageId)
    if (!comment || comment.source !== 'telegram') {
      continue
    }
    const post = postStore.getPost(comment.post_id)
    const removed = commentStore.deleteComment(comment.comment_id)
    if (!removed) {
      continue
    }
    removedIds.push(removed.comment_id)

    if (!post) {
      continue
    }
    try {
      await syncTelegramAdminCommentNotification({
        comment: removed,
        postId: post.post_id,
        channelChatId: post.chat_id,
        messageMid: post.message_mid,
        deleted: true,
      })
    } catch (err: unknown) {
      logger.warn('[commentEditSync] TG admin notification (deleted) failed', {
        commentId: removed.comment_id,
        err,
      })
    }

    const newCount = postStore.decrementCommentCount(post.post_id)
    if (newCount !== null && bot) {
      const updatedPost = postStore.getPost(post.post_id)
      if (updatedPost) {
        await postStore.updateButtonCaption(bot, updatedPost).catch((err: unknown) => {
          logger.warn('[commentEditSync] updateButtonCaption failed after TG deletion', {
            postId: post.post_id,
            err,
          })
        })
      }
    }
    logger.info('[commentEditSync] TG comment deletion synced to MAX', {
      discussionChatId,
      tgMessageId,
      commentId: removed.comment_id,
    })
  }
  return removedIds
}
