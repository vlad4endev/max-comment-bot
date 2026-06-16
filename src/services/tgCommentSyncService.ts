/**
 * tgCommentSyncService.ts
 *
 * Слушает новые сообщения из TG-треда обсуждения канала
 * и записывает их как комментарии в miniapp БД Max.
 *
 * Подключается к существующему polling-циклу tgChainForwarder.
 */

import type { Bot } from '@maxhub/max-bot-api'

import type { TgChainRecord } from '../api/adminPanelState'
import type { TgMessage } from '../forwarder/telegramReader'
import { commentStore } from './commentStore'
import { notifyAdminsNewMiniappComment } from './notificationService'
import { channelRegistry } from './channelRegistry'
import {
  findMappingByThreadMsgId,
  linkThreadMessageToChannelPost,
} from './postCommentMappingStore'
import { postStore } from './postStore'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { isCommentSynced, markCommentSynced } from '../utils/commentSyncGuard'
import {
  resolveDiscussionThreadRootMsgId,
  shouldSyncTgCommentToMax,
} from '../utils/commentSyncFilter'
import { logger } from '../utils/logger'

export function isDiscussionAutoForward(message: TgMessage): boolean {
  return Boolean(
    message.is_automatic_forward ||
      message.forward_origin?.type === 'channel' ||
      (message.sender_chat && message.forward_from_message_id != null),
  )
}

/**
 * Связывает авто-репост канала в discussion group с post_comment_mapping.
 */
export function handleDiscussionAutoForward(message: TgMessage, chainId: string): void {
  const channelMsgId =
    message.forward_origin?.message_id ?? message.forward_from_message_id ?? null
  if (channelMsgId == null) {
    return
  }
  linkThreadMessageToChannelPost(chainId, channelMsgId, message.chat.id, message.message_id)
  logger.info('[tgCommentSync] linked discussion post', {
    chainId,
    channelMsgId,
    threadMsgId: message.message_id,
    threadChatId: message.chat.id,
  })
}

/**
 * Комментарий в TG discussion group → комментарий в miniapp.
 */
export async function handleTgComment(
  message: TgMessage,
  chain: TgChainRecord,
  bot: Bot,
  discussionChatId: number,
): Promise<void> {
  if (!chain.forward_comments) {
    return
  }

  try {
    if (!message.reply_to_message) {
      return
    }

    const tgCommentId = message.message_id
    const threadRootMsgId = resolveDiscussionThreadRootMsgId(message)
    if (threadRootMsgId == null) {
      return
    }

    if (isCommentSynced(`tg:${tgCommentId}`)) {
      return
    }

    if (commentStore.findCommentByTgMessageId(tgCommentId)) {
      return
    }

    const mapping = findMappingByThreadMsgId(chain.id, threadRootMsgId)
    if (!mapping?.max_mid) {
      return
    }

    const maxChatId = resolveCanonicalChannelChatId(chain.max_chat_id) ?? chain.max_chat_id
    const post = postStore.findPostByChannelMessage(maxChatId, mapping.max_mid)
    if (!post) {
      logger.warn('[tgCommentSync] post not found for mapping', {
        chainId: chain.id,
        maxMid: mapping.max_mid,
        maxChatId,
      })
      return
    }

    const text = (message.text || message.caption || '').trim()
    if (!text) {
      return
    }

    const tgToken = chain.bot_token?.trim()
    if (!tgToken) {
      return
    }

    const shouldSync = await shouldSyncTgCommentToMax({
      message,
      chain,
      token: tgToken,
      discussionChatId,
      postCommentCount: post.comment_count,
      threadRootMsgId,
    })
    if (!shouldSync) {
      logger.debug('[tgCommentSync] skipped by filter', {
        chainId: chain.id,
        tgCommentId,
        postId: post.post_id,
      })
      return
    }

    const authorName =
      [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') ||
      message.sender_chat?.title ||
      message.from?.username ||
      'Аноним'
    const userId = typeof message.from?.id === 'number' ? message.from.id : 0
    const saved = commentStore.saveTelegramThreadComment(
      {
        post_id: post.post_id,
        user_id: userId > 0 ? userId : 1,
        username: authorName,
        text,
      },
      tgCommentId,
    )

    markCommentSynced(`max:${saved.comment_id}`)

    const newCount = postStore.incrementCommentCount(post.post_id)
    if (newCount !== null) {
      const updatedPost = postStore.getPost(post.post_id)
      if (updatedPost) {
        await postStore.updateButtonCaption(bot, updatedPost)
      }
    }

    const channelTitle = channelRegistry.getChannel(maxChatId)?.title ?? chain.max_title ?? '—'
    try {
      await notifyAdminsNewMiniappComment(bot, {
        commentId: saved.comment_id,
        channelChatId: maxChatId,
        postText: post.text,
        channelTitle,
        username: authorName,
        commentText: text,
        postId: post.post_id,
      })
    } catch (err: unknown) {
      logger.warn('[tgCommentSync] notify MAX admins failed', { err })
    }

    logger.info('[tgCommentSync] synced TG comment to miniapp', {
      chainId: chain.id,
      tgCommentId,
      commentId: saved.comment_id,
      postId: post.post_id,
    })
  } catch (err: unknown) {
    logger.error('[tgCommentSync] unhandled error', err)
  }
}
