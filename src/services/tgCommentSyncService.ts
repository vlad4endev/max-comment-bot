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
import type { Comment } from './commentStore'
import { commentStore } from './commentStore'
import {
  notifyAdminsNewMiniappComment,
  notifyUserAboutMiniappReply,
  syncAdminCommentNotification,
} from './notificationService'
import { syncTelegramAdminCommentNotification } from './telegramAdminNotificationService'
import { channelRegistry } from './channelRegistry'
import {
  findMappingByTgMsgId,
  findMappingByThreadMsgId,
  linkThreadMessageToChannelPost,
} from './postCommentMappingStore'
import { postStore } from './postStore'
import type { Post } from './postStore'
import { resolveCanonicalChannelChatId } from './resolveChannelChatId'
import { isCommentSynced, markCommentSynced } from '../utils/commentSyncGuard'
import {
  isMaxAdminReplyInTelegram,
  isTelegramOriginComment,
  isTgCommentFromAdmin,
  resolveChannelMsgIdFromThreadRoot,
  resolveDiscussionThreadRootMsgId,
  resolveTgCommentAuthor,
  resolveThreadRootMessage,
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

function listExistingReplyTexts(comment: Comment): string[] {
  const thread =
    Array.isArray(comment.replies) && comment.replies.length > 0
      ? comment.replies
      : comment.reply?.text?.trim()
        ? [comment.reply]
        : []
  return thread.map((r) => r.text.trim()).filter(Boolean)
}

/**
 * Реплай в TG на комментарий, перенесённый из TG в MAX: пометка «отвечено в Telegram»,
 * без исходящего сообщения в TG. Текст ответа админа сохраняется в MAX.
 */
async function handleTgReplyToSyncedTelegramComment(
  message: TgMessage,
  parentComment: Comment,
  chain: TgChainRecord,
  bot: Bot,
  maxChatId: number,
  post: Post,
  tgCommentId: number,
  isAdmin: boolean,
): Promise<void> {
  const text = (message.text || message.caption || '').trim()
  commentStore.markAnsweredInTelegram(parentComment.comment_id)

  if (!isAdmin || !text || isMaxAdminReplyInTelegram(text)) {
    markCommentSynced(`tg:${tgCommentId}`)
    logger.info('[tgCommentSync] marked TG-origin comment as answered in Telegram', {
      chainId: chain.id,
      tgCommentId,
      parentCommentId: parentComment.comment_id,
      isAdmin,
    })
    return
  }

  if (listExistingReplyTexts(parentComment).includes(text)) {
    markCommentSynced(`tg:${tgCommentId}`)
    return
  }

  const channelTitle =
    channelRegistry.getChannel(maxChatId)?.title?.trim() || chain.max_title?.trim() || 'Канал'

  const updated = commentStore.addReply(
    parentComment.comment_id,
    text,
    channelTitle,
    [],
    'Telegram',
    true,
  )
  if (!updated) {
    markCommentSynced(`tg:${tgCommentId}`)
    return
  }

  markCommentSynced(`tg:${tgCommentId}`)
  markCommentSynced(`max-reply:${updated.comment_id}:${text}`)

  try {
    await syncAdminCommentNotification(bot, updated, post.post_id, maxChatId)
  } catch (err: unknown) {
    logger.warn('[tgCommentSync] sync MAX admin notification failed', {
      commentId: updated.comment_id,
      err,
    })
  }
  try {
    await syncTelegramAdminCommentNotification({
      comment: updated,
      postId: post.post_id,
      channelChatId: maxChatId,
      messageMid: post.message_mid,
    })
  } catch (err: unknown) {
    logger.warn('[tgCommentSync] sync TG admin notification failed', {
      commentId: updated.comment_id,
      err,
    })
  }
  try {
    await notifyUserAboutMiniappReply(bot, {
      userId: Number(updated.user_id),
      commentId: updated.comment_id,
      postText: post.text,
      userCommentText: updated.text,
      adminReplyText: text,
      postId: post.post_id,
      channelChatId: maxChatId,
    })
  } catch (err: unknown) {
    logger.warn('[tgCommentSync] notify user about TG admin reply failed', {
      commentId: updated.comment_id,
      err,
    })
  }

  logger.info('[tgCommentSync] synced TG admin reply to MAX comment', {
    chainId: chain.id,
    tgCommentId,
    parentCommentId: parentComment.comment_id,
    postId: post.post_id,
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

    let mapping = findMappingByThreadMsgId(chain.id, threadRootMsgId)
    if (!mapping?.max_mid) {
      const threadRoot = resolveThreadRootMessage(message)
      const channelMsgId =
        threadRoot != null ? resolveChannelMsgIdFromThreadRoot(threadRoot) : null
      if (channelMsgId != null) {
        mapping = findMappingByTgMsgId(chain.id, channelMsgId)
        if (mapping?.max_mid) {
          linkThreadMessageToChannelPost(
            chain.id,
            channelMsgId,
            message.chat.id,
            threadRootMsgId,
          )
          logger.info('[tgCommentSync] linked thread via channel msg fallback', {
            chainId: chain.id,
            channelMsgId,
            threadMsgId: threadRootMsgId,
          })
        }
      }
    }
    if (!mapping?.max_mid) {
      logger.debug('[tgCommentSync] no post mapping for thread', {
        chainId: chain.id,
        threadRootMsgId,
        tgCommentId,
      })
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

    const tgToken = chain.bot_token?.trim()
    if (!tgToken) {
      return
    }

    const isAdmin = await isTgCommentFromAdmin(message, tgToken, chain, discussionChatId)
    const directReplyId = message.reply_to_message.message_id

    if (directReplyId !== threadRootMsgId) {
      const parentComment = commentStore.findCommentByTgMessageId(directReplyId)
      if (parentComment && isTelegramOriginComment(parentComment)) {
        await handleTgReplyToSyncedTelegramComment(
          message,
          parentComment,
          chain,
          bot,
          maxChatId,
          post,
          tgCommentId,
          isAdmin,
        )
        return
      }
      if (isAdmin && parentComment) {
        markCommentSynced(`tg:${tgCommentId}`)
        logger.debug('[tgCommentSync] admin reply to non-TG-origin comment skipped', {
          chainId: chain.id,
          tgCommentId,
          parentCommentId: parentComment.comment_id,
          parentSource: parentComment.source ?? null,
        })
        return
      }
    }

    const text = (message.text || message.caption || '').trim()
    if (!text) {
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

    const { userId, username: authorName } = resolveTgCommentAuthor(
      message,
      chain,
      discussionChatId,
    )
    const saved = commentStore.saveTelegramThreadComment(
      {
        post_id: post.post_id,
        user_id: userId,
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
